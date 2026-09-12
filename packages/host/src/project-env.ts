/**
 * Where a project's environment command is configured (M16-T17).
 *
 * The configuration is **machine-local**, keyed by canonical project root, and
 * lives beside the host's other state. It is deliberately not read from
 * `<project>/.laser/settings.json`, and that is a security decision rather than
 * a filing one: the configuration names an executable, so a file inside a
 * checkout could otherwise make cloning a repository enough to run a program of
 * the repository author's choosing, with the person's credentials in reach.
 * A person configures this in Laser, on the machine it applies to.
 *
 * Saving a configuration is the approval. The `{command, args}` fingerprint is
 * recorded at that moment; if the stored configuration is later edited by
 * anything other than this path, the fingerprint stops matching and the hook
 * does not run until a person approves it again.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  projectEnvApproved,
  projectEnvFingerprint,
  type ProjectEnvConfig,
  type ProjectEnvStatus,
  type ProjectTrust,
} from "@lasercode/protocol";
import { canonical } from "./trust.js";

/**
 * Whether a project's trust state permits running its environment command.
 *
 * `not_required` is the ordinary case and must be allowed: it means the
 * directory ships nothing trust-gated, which is true of most projects. The
 * environment command itself is machine-local and separately approved, so it is
 * not what makes a directory trust-gated.
 *
 * `unknown` and `declined` refuse: a person has either not been asked yet about
 * this project's own configuration, or has said no, and neither is a moment to
 * start running a program for it.
 */
export function projectEnvTrustAllows(trust: ProjectTrust): boolean {
  return trust === "trusted" || trust === "not_required";
}

export interface ProjectEnvStoreOptions {
  /** Where the configuration is persisted. Absent = memory only (tests). */
  storePath?: string;
  onChange?: (status: ProjectEnvStatus) => void;
}

interface Stored {
  enabled: boolean;
  command: string;
  args: string[];
  required: boolean;
  allowProviderKeys?: string[];
  approvedFingerprint?: string;
}

export class ProjectEnvStore {
  private readonly configs = new Map<string, Stored>();

  constructor(private readonly options: ProjectEnvStoreOptions = {}) {
    this.load();
  }

  get(cwd: string): ProjectEnvConfig | undefined {
    const stored = this.configs.get(canonical(cwd));
    return stored ? { ...stored, args: [...stored.args] } : undefined;
  }

  /**
   * Save (or clear) a project's configuration. This is the approval moment:
   * the person is looking at the command they are about to allow.
   */
  set(
    cwd: string,
    config: {
      enabled: boolean;
      command: string;
      args?: string[];
      required?: boolean;
      allowProviderKeys?: string[];
    } | null,
  ): ProjectEnvConfig | undefined {
    const key = canonical(cwd);
    if (config === null) {
      this.configs.delete(key);
      this.persist();
      return undefined;
    }
    const args = [...(config.args ?? [])];
    const next: Stored = {
      enabled: config.enabled,
      command: config.command,
      args,
      required: config.required ?? true,
      ...(config.allowProviderKeys?.length ? { allowProviderKeys: [...config.allowProviderKeys] } : {}),
      approvedFingerprint: projectEnvFingerprint({ command: config.command, args }),
    };
    this.configs.set(key, next);
    this.persist();
    return { ...next, args: [...next.args] };
  }

  /** Projects with a configuration, for the settings list. */
  configured(): string[] {
    return [...this.configs.keys()].sort();
  }

  /**
   * The status a person sees, without the worker's answer. A worker that is up
   * enriches this with names and any failure; a project whose worker is not
   * running still shows what is configured and whether it is approved.
   */
  baseStatus(cwd: string, trust: ProjectTrust): ProjectEnvStatus {
    const key = canonical(cwd);
    const config = this.get(key);
    if (!config) return { cwd: key, state: "not-configured", approved: false };
    if (!config.enabled) return { cwd: key, state: "off", config, approved: projectEnvApproved(config) };
    if (!projectEnvTrustAllows(trust)) return { cwd: key, state: "untrusted", config, approved: projectEnvApproved(config) };
    if (!projectEnvApproved(config)) return { cwd: key, state: "needs-approval", config, approved: false };
    return { cwd: key, state: "failed", config, approved: true };
  }

  emit(status: ProjectEnvStatus): void {
    this.options.onChange?.(status);
  }

  // ------------------------------------------------------------- storage

  private load(): void {
    const file = this.options.storePath;
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const projects = (parsed as { projects?: unknown })?.projects;
      if (!projects || typeof projects !== "object") return;
      for (const [cwd, value] of Object.entries(projects as Record<string, unknown>)) {
        const v = value as Partial<Stored> | null;
        if (!v || typeof v.command !== "string" || !v.command) continue;
        const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [];
        this.configs.set(canonical(cwd), {
          enabled: v.enabled === true,
          command: v.command,
          args,
          required: v.required !== false,
          ...(Array.isArray(v.allowProviderKeys)
            ? { allowProviderKeys: v.allowProviderKeys.filter((a): a is string => typeof a === "string") }
            : {}),
          ...(typeof v.approvedFingerprint === "string" ? { approvedFingerprint: v.approvedFingerprint } : {}),
        });
      }
    } catch {
      /* first run, or a truncated file: nothing is configured */
    }
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file) return;
    const projects: Record<string, Stored> = {};
    for (const [cwd, value] of this.configs) projects[cwd] = value;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${process.pid}.project-env.tmp`);
      writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* read-only home: the configuration still works for this run */
    }
  }
}
