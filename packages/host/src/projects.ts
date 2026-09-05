/**
 * ProjectRegistry (M2-T4) — the projects piorbit knows about, server-side.
 *
 * Before this, "projects" lived in the browser's localStorage, so the CLI could
 * not see them, a second device started empty, and removing one on the phone
 * did nothing on the desktop. The list now lives with the host: pinned
 * directories the user added, unioned with every directory the session catalog
 * has seen, and it survives a restart.
 *
 * It also owns the project-trust decision (see trust.ts for why the host has to
 * make one). `ensureTrusted()` is called before a worker starts: it answers
 * from a saved decision when there is one, and otherwise asks the connected
 * clients through `pi/project/trust_request` and blocks the worker start until
 * somebody answers. Declining is not an error — the worker starts with project
 * resources switched off, exactly like Pi's own "no".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ErrorCodes, ProtocolError, type ProjectInfo, type ProjectTrust } from "@piorbit/protocol";
import type { SessionCatalog } from "./catalog.js";
import { canonical, defaultProjectTrust, savedPiTrust, trustReasons } from "./trust.js";

interface StoredProject {
  addedAt: string;
  lastUsedAt?: string;
  pinned: boolean;
  /** Only set once a person decided in piorbit and asked us to remember. */
  trust?: "trusted" | "declined";
}

export interface TrustRequest {
  id: string;
  cwd: string;
  reasons: string[];
  timeoutMs: number;
}

export interface ProjectRegistryOptions {
  catalog: SessionCatalog;
  /** Pi's agent dir; where `trust.json` and the global settings live. */
  agentDir: string;
  /** Where the project list is persisted. Absent = memory only (tests). */
  storePath?: string;
  onChange?: (projects: ProjectInfo[]) => void;
  onTrustRequest?: (request: TrustRequest) => void;
  onTrustResolved?: (resolved: { id: string; cwd: string; trusted: boolean }) => void;
  /** False when nobody could answer a trust prompt, so we fail fast instead of hanging. */
  hasClients?: () => boolean;
  /** How long a trust prompt stays open before it declines for this run. */
  trustTimeoutMs?: number;
  now?: () => Date;
}

interface Pending {
  request: TrustRequest;
  promise: Promise<boolean>;
  settle: (trusted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TRUST_TIMEOUT_MS = 120_000;

export class ProjectRegistry {
  private readonly stored = new Map<string, StoredProject>();
  /** Decisions that apply to this host process only ("just this once"). */
  private readonly sessionTrust = new Map<string, boolean>();
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => Date;
  private nextRequestId = 1;

  constructor(private readonly options: ProjectRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  // ------------------------------------------------------------- the list

  /** Pinned projects ∪ directories the catalog has seen, by name. */
  list(): ProjectInfo[] {
    const counts = this.options.catalog.cwdCounts();
    const cwds = new Set<string>([...this.stored.keys(), ...counts.keys()]);
    const out: ProjectInfo[] = [];
    for (const cwd of cwds) {
      const stored = this.stored.get(cwd);
      const { trust, reasons } = this.trustOf(cwd);
      out.push({
        cwd,
        name: basename(cwd) || cwd,
        addedAt: stored?.addedAt ?? this.now().toISOString(),
        ...(stored?.lastUsedAt ? { lastUsedAt: stored.lastUsedAt } : {}),
        trust,
        ...(reasons.length > 0 ? { trustReasons: reasons } : {}),
        pinned: stored?.pinned ?? false,
        sessionCount: counts.get(cwd) ?? 0,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
  }

  get(cwd: string): ProjectInfo {
    const key = canonical(cwd);
    const found = this.list().find((p) => p.cwd === key);
    if (found) return found;
    const { trust, reasons } = this.trustOf(key);
    return {
      cwd: key,
      name: basename(key) || key,
      addedAt: this.now().toISOString(),
      trust,
      ...(reasons.length > 0 ? { trustReasons: reasons } : {}),
      pinned: false,
      sessionCount: 0,
    };
  }

  add(cwd: string): ProjectInfo {
    const key = canonical(cwd);
    const existing = this.stored.get(key);
    this.stored.set(key, { ...(existing ?? { addedAt: this.now().toISOString() }), pinned: true });
    this.persist();
    this.emit();
    return this.get(key);
  }

  /**
   * Forget a project. Sessions on disk are untouched, so a directory the
   * catalog still knows keeps showing up — unpinned, as a discovered project.
   */
  remove(cwd: string): void {
    const key = canonical(cwd);
    if (!this.stored.delete(key)) return;
    this.sessionTrust.delete(key);
    this.persist();
    this.emit();
  }

  /** Record that a session in this directory was just used. */
  touch(cwd: string): void {
    const key = canonical(cwd);
    const existing = this.stored.get(key) ?? { addedAt: this.now().toISOString(), pinned: false };
    this.stored.set(key, { ...existing, lastUsedAt: this.now().toISOString() });
    this.persist();
  }

  // ------------------------------------------------------------- trust

  /** The decision as it stands, without asking anyone. */
  trustOf(cwd: string): { trust: ProjectTrust; reasons: string[] } {
    const key = canonical(cwd);
    const { reasons, required } = trustReasons(key);
    if (!required) return { trust: "not_required", reasons: [] };

    const session = this.sessionTrust.get(key);
    if (session !== undefined) return { trust: session ? "trusted" : "declined", reasons };

    const remembered = this.stored.get(key)?.trust;
    if (remembered) return { trust: remembered, reasons };

    const pi = savedPiTrust(key, this.options.agentDir);
    if (pi !== undefined) return { trust: pi ? "trusted" : "declined", reasons };

    const fallback = defaultProjectTrust(this.options.agentDir);
    if (fallback === "always") return { trust: "trusted", reasons };
    if (fallback === "never") return { trust: "declined", reasons };
    return { trust: "unknown", reasons };
  }

  /** Answer a `pi/project/trust_request`, or change a decision later. */
  setTrust(cwd: string, trusted: boolean, remember = false): ProjectInfo {
    const key = canonical(cwd);
    if (remember) {
      const existing = this.stored.get(key) ?? { addedAt: this.now().toISOString(), pinned: false };
      this.stored.set(key, { ...existing, trust: trusted ? "trusted" : "declined" });
      this.sessionTrust.delete(key);
      this.persist();
    } else {
      this.sessionTrust.set(key, trusted);
    }
    this.pending.get(key)?.settle(trusted);
    this.emit();
    return this.get(key);
  }

  /**
   * Resolve trust for a directory we are about to start a worker in, asking a
   * client when nobody has decided. Returns the flag the worker should run
   * with, or `undefined` for "piorbit has no opinion — keep Pi's own default".
   *
   * `not_required` must map to `undefined`, not `false`. A directory with no
   * trust-gated `.pi` resources was never a question, and answering `false`
   * would pin it as *declined*: the settings screen would tell the user they
   * had refused a project they were never asked about, and a `.pi/settings.json`
   * created later in that session would be silently ignored. Throws only when
   * nobody could possibly answer.
   */
  async ensureTrusted(cwd: string): Promise<boolean | undefined> {
    const key = canonical(cwd);
    const { trust, reasons } = this.trustOf(key);
    if (trust === "trusted") return true;
    if (trust === "declined") return false;
    if (trust === "not_required") return undefined;

    const inflight = this.pending.get(key);
    if (inflight) return inflight.promise;

    if (this.options.hasClients && !this.options.hasClients()) {
      throw new ProtocolError(
        ErrorCodes.ProjectUntrusted,
        `${key} has project-local agent resources (${reasons.join(", ")}) and no trust decision. ` +
          `Open piorbit and approve the project, or run \`pi\` there once and answer its trust prompt.`,
        { cwd: key, reasons },
      );
    }

    const timeoutMs = this.options.trustTimeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS;
    const request: TrustRequest = { id: `trust-${this.nextRequestId++}`, cwd: key, reasons, timeoutMs };
    let settle!: (trusted: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      settle = (trusted: boolean) => {
        const entry = this.pending.get(key);
        if (!entry || entry.request.id !== request.id) return;
        clearTimeout(entry.timer);
        this.pending.delete(key);
        this.options.onTrustResolved?.({ id: request.id, cwd: key, trusted });
        resolve(trusted);
      };
    });
    // Nobody answered: run without project resources rather than hang a click
    // forever. The project stays `unknown`, so the next open asks again.
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    this.pending.set(key, { request, promise, settle, timer });
    this.options.onTrustRequest?.(request);
    return promise;
  }

  /** Trust prompts waiting for an answer, so a client that connects late sees them. */
  pendingTrustRequests(): TrustRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** Settle every open prompt as "declined" (host shutting down). */
  close(): void {
    for (const pending of [...this.pending.values()]) pending.settle(false);
  }

  // ------------------------------------------------------------- storage

  private emit(): void {
    this.options.onChange?.(this.list());
  }

  private load(): void {
    const file = this.options.storePath;
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const projects = (parsed as { projects?: unknown })?.projects;
      if (!projects || typeof projects !== "object") return;
      for (const [cwd, value] of Object.entries(projects as Record<string, unknown>)) {
        const v = value as Partial<StoredProject> | null;
        if (!v || typeof v.addedAt !== "string") continue;
        this.stored.set(canonical(cwd), {
          addedAt: v.addedAt,
          pinned: v.pinned === true,
          ...(typeof v.lastUsedAt === "string" ? { lastUsedAt: v.lastUsedAt } : {}),
          ...(v.trust === "trusted" || v.trust === "declined" ? { trust: v.trust } : {}),
        });
      }
    } catch {
      /* first run, or a truncated file: start from the catalog alone */
    }
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file) return;
    const projects: Record<string, StoredProject> = {};
    for (const [cwd, value] of this.stored) projects[cwd] = value;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${process.pid}.projects.tmp`);
      writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2));
      renameSync(tmp, file);
    } catch {
      /* read-only home: the list still works for this run */
    }
  }
}
