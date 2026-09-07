/**
 * AttentionTracker (M2-T2) — the host's answer to "which session wants me?".
 *
 * The host is the only place that sees every session of every project, so the
 * state machine lives here rather than in a client: a phone that has never
 * opened a session still gets the same inbox as the desktop.
 *
 * Inputs, in priority order:
 *   waiting_for_input  an extension dialog is open (`pi/ui/request` unanswered)
 *   error              the last thing that happened was an extension error or a
 *                      worker crash, and nobody has looked since
 *   working            the agent is running (agent_start … agent_end/settled)
 *   finished_unread    the session file changed after the last time a client
 *                      said it had seen it
 *   idle               none of the above
 *
 * "Seen" is persisted (a small JSON file next to the host's other state) so
 * `finished_unread` survives a host restart or a browser reload — the whole
 * point of the state. Sequence numbers do not survive: they are per worker
 * process and restart at 1, so the durable record is a timestamp and the
 * comparison is against the session file's mtime.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionAttention, SessionSummary } from "@lasercode/protocol";

/** Live, per-session, in-memory. Everything here is lost on a host restart. */
interface Live {
  cwd: string;
  running: boolean;
  dialogs: Set<string>;
  error?: string;
  /** Highest seq seen from the worker, for `pi/session/seen { seq }`. */
  lastSeq: number;
  /** ISO of the last agent turn that ended while nobody was looking. */
  finishedAt?: string;
}

interface Seen {
  /** ISO time a client last said it had read this session. */
  at: string;
  /** Seq it had read up to, within the worker epoch that was live then. */
  seq?: number;
}

export interface AttentionSnapshot {
  path: string;
  cwd: string;
  attention: SessionAttention;
  at: string;
}

export interface AttentionTrackerOptions {
  /** File the seen-map is persisted to. Absent = memory only (tests). */
  storePath?: string;
  /** Notified whenever a session's attention actually changes. */
  onChange?: (snapshot: AttentionSnapshot) => void;
  /** A client viewed this session; independent of whether its attention changed. */
  onSeen?: (path: string) => void;
  /**
   * The session file's mtime, so a session driven from a terminal — the case
   * the file layer exists for — can turn up unread without anybody opening it
   * here first. Wired to the catalog by the host.
   */
  modifiedAt?: (path: string) => string | undefined;
  now?: () => Date;
}

export class AttentionTracker {
  private readonly live = new Map<string, Live>();
  private readonly seen = new Map<string, Seen>();
  private readonly last = new Map<string, SessionAttention>();
  private readonly now: () => Date;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * When laser first ran on this machine. Sessions untouched since then are
   * history and stay idle; anything that changes afterwards is unread even if
   * it has never been opened here. Without it a session a terminal Pi just
   * finished could never reach the inbox until someone opened it — which is
   * exactly the trip the inbox exists to save.
   */
  private baseline: string | undefined;

  constructor(private readonly options: AttentionTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.load();
    if (this.baseline === undefined) {
      this.baseline = this.now().toISOString();
      this.schedulePersist();
    }
  }

  // ------------------------------------------------------------- inputs

  /** A worker event for one session. `cwd` keys the project the row belongs to. */
  observeUpdate(path: string, cwd: string, kind: string, seq: number): void {
    const live = this.ensure(path, cwd);
    if (seq > live.lastSeq) live.lastSeq = seq;
    switch (kind) {
      case "agent_start":
        live.running = true;
        delete live.error;
        break;
      case "agent_end":
      case "agent_settled":
        if (live.running) live.finishedAt = this.now().toISOString();
        live.running = false;
        break;
      case "extension_error":
        live.error = "extension error";
        break;
      default:
        break;
    }
    this.publish(path);
  }

  /** An extension raised a dialog: this session is blocked on a person. */
  dialogRaised(path: string, cwd: string, id: string): void {
    this.ensure(path, cwd).dialogs.add(id);
    this.publish(path);
  }

  /** The dialog was answered, cancelled, or settled by the worker. */
  dialogResolved(path: string, id: string): void {
    const live = this.live.get(path);
    if (!live || !live.dialogs.delete(id)) return;
    this.publish(path);
  }

  /**
   * A client answered a dialog. The worker's UI bridge deliberately emits no
   * `dialogResolved` in that case (the answerer already knows), so the host
   * clears its own bookkeeping here or the row stays "waiting for you" forever.
   */
  dialogAnswered(id: string): void {
    for (const [path, live] of this.live) {
      if (live.dialogs.delete(id)) this.publish(path);
    }
  }

  /** A worker died: every session it held is in an error state until retried. */
  workerCrashed(cwd: string, message: string): void {
    for (const [path, live] of this.live) {
      if (live.cwd !== cwd) continue;
      live.running = false;
      live.dialogs.clear();
      live.error = message;
      this.publish(path);
    }
  }

  /** A worker came back: clear the crash marker, keep everything else. */
  workerRecovered(cwd: string): void {
    for (const [path, live] of this.live) {
      if (live.cwd !== cwd || live.error === undefined) continue;
      delete live.error;
      this.publish(path);
    }
  }

  /** A worker retired cleanly. Its sessions are simply not running any more. */
  workerRetired(cwd: string): void {
    for (const [path, live] of this.live) {
      if (live.cwd !== cwd) continue;
      live.running = false;
      this.publish(path);
    }
  }

  /**
   * A client read the session. Clears `finished_unread` and any error marker;
   * a dialog still open keeps the row in `waiting_for_input`, which is right —
   * seeing a question is not answering it.
   */
  markSeen(path: string, cwd: string | undefined, seq?: number): void {
    const live = cwd ? this.ensure(path, cwd) : this.live.get(path);
    const at = this.now().toISOString();
    this.seen.set(path, { at, ...(seq !== undefined ? { seq } : {}) });
    if (live) {
      delete live.error;
      delete live.finishedAt;
    }
    this.schedulePersist();
    this.publish(path, cwd);
    this.options.onSeen?.(path);
  }

  /** Forget a session entirely (its file is gone). */
  forget(path: string): void {
    this.live.delete(path);
    this.last.delete(path);
    if (this.seen.delete(path)) this.schedulePersist();
  }

  // ------------------------------------------------------------- outputs

  seenAt(path: string): string | undefined {
    return this.seen.get(path)?.at;
  }

  lastSeq(path: string): number {
    return this.live.get(path)?.lastSeq ?? 0;
  }

  cwdOf(path: string): string | undefined {
    return this.live.get(path)?.cwd;
  }

  /**
   * Attention for one session. `modifiedAt` comes from the catalog, so a
   * session someone drove from a terminal also turns up unread.
   */
  attentionOf(path: string, modifiedAt?: string): SessionAttention {
    const live = this.live.get(path);
    if (live) {
      if (live.dialogs.size > 0) return "waiting_for_input";
      if (live.error !== undefined) return "error";
      if (live.running) return "working";
    }
    // Never opened here: compare against when laser first ran instead, so
    // history stays idle (marking every old session unread on first launch
    // would make the inbox useless) while anything that has changed since
    // still asks for a look.
    const floor = this.seen.get(path)?.at ?? this.baseline;
    if (floor === undefined) return "idle";
    const changedAt = laterOf(live?.finishedAt, modifiedAt ?? this.options.modifiedAt?.(path));
    return changedAt !== undefined && changedAt > floor ? "finished_unread" : "idle";
  }

  /** Stamp `attention` (and `seenAt`) onto catalog rows. */
  decorate<T extends SessionSummary>(sessions: readonly T[]): T[] {
    return sessions.map((summary) => {
      const seenAt = this.seenAt(summary.path);
      return {
        ...summary,
        attention: this.attentionOf(summary.path, summary.modifiedAt),
        ...(seenAt ? { seenAt } : {}),
      };
    });
  }

  /** Flush the seen-map now (host shutdown). */
  close(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    this.persist();
  }

  // ------------------------------------------------------------- internals

  private ensure(path: string, cwd: string): Live {
    const existing = this.live.get(path);
    if (existing) {
      existing.cwd = cwd;
      return existing;
    }
    const live: Live = { cwd, running: false, dialogs: new Set(), lastSeq: 0 };
    this.live.set(path, live);
    return live;
  }

  /**
   * Emit only on a real transition; this feeds a notification per session.
   * `cwdHint` covers a session with no live state — marking an old session read
   * still has to reach the other clients showing it.
   */
  private publish(path: string, cwdHint?: string): void {
    const cwd = this.live.get(path)?.cwd ?? cwdHint;
    if (cwd === undefined) return;
    const attention = this.attentionOf(path);
    if (this.last.get(path) === attention) return;
    this.last.set(path, attention);
    this.options.onChange?.({ path, cwd, attention, at: this.now().toISOString() });
  }

  private load(): void {
    const file = this.options.storePath;
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const since = (parsed as { since?: unknown })?.since;
      if (typeof since === "string") this.baseline = since;
      const sessions = (parsed as { sessions?: unknown })?.sessions;
      if (!sessions || typeof sessions !== "object") return;
      for (const [path, value] of Object.entries(sessions as Record<string, unknown>)) {
        const at = (value as { at?: unknown })?.at;
        const seq = (value as { seq?: unknown })?.seq;
        if (typeof at !== "string") continue;
        this.seen.set(path, { at, ...(typeof seq === "number" ? { seq } : {}) });
      }
    } catch {
      /* first run, or a truncated file: start empty rather than fail to boot */
    }
  }

  /** Coalesce writes: opening ten sessions must not mean ten file writes. */
  private schedulePersist(): void {
    if (!this.options.storePath || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.persist();
    }, 500);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file) return;
    const sessions: Record<string, Seen> = {};
    for (const [path, seen] of this.seen) sessions[path] = seen;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${Date.now()}.attention.tmp`);
      writeFileSync(tmp, JSON.stringify({ version: 1, since: this.baseline, sessions }, null, 2));
      renameSync(tmp, file);
    } catch {
      /* read-only home, full disk: attention is a convenience, not a blocker */
    }
  }
}

function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}
