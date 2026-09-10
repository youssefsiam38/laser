import { ErrorCodes, ProtocolError, SESSION_AGENT_ENTRY_TYPE, type SessionState } from "@lasercode/protocol";

export interface FirstTurnAdmission {
  state: SessionState;
  entries: readonly unknown[];
  roleKind: "root" | "child" | "beam" | "chat" | undefined;
  pendingTrayCount: number;
  dialogCount: number;
  hasGoal: boolean;
  hasLiveWork: boolean;
  runningToolCount: number;
}

const ALLOWED_ENTRY_TYPES = new Set(["model_change", "thinking_level_change", "session_info"]);

/** Reject every state that means this identity has already been used. */
export function assertFirstTurnAdmission(input: FirstTurnAdmission): void {
  const state = input.state;
  const hasHistory = input.entries.some((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const item = entry as { type?: unknown; customType?: unknown };
    if (item.type === "custom" && item.customType === SESSION_AGENT_ENTRY_TYPE) return false;
    return typeof item.type !== "string" || !ALLOWED_ENTRY_TYPES.has(item.type);
  });
  const pristine = input.roleKind === "root"
    && state.messageCount === 0
    && state.pendingMessageCount === 0
    && !state.isStreaming
    && !state.isCompacting
    && input.pendingTrayCount === 0
    && input.dialogCount === 0
    && !input.hasGoal
    && !input.hasLiveWork
    && input.runningToolCount === 0
    && !hasHistory;
  if (!pristine) {
    throw new ProtocolError(
      ErrorCodes.InvalidParams,
      "This conversation has already started, so its agent cannot be changed. Start a new conversation to choose another agent.",
    );
  }
}

/** Per-session admission held only through engine prompt preflight. */
export class FirstTurnLock {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * `wait: false` preserves ordinary prompt semantics: a concurrent invocation
   * is refused, not silently turned into a later turn. First-turn competitors
   * wait so exactly one can validate the pristine identity after its predecessor.
   */
  busy(path: string): boolean {
    return this.tails.has(path);
  }

  async acquire(path: string, wait: boolean): Promise<(() => void) | undefined> {
    const previous = this.tails.get(path);
    if (previous && !wait) return undefined;
    const lease = this.install(path, previous);
    if (previous) await previous;
    return lease;
  }

  private install(path: string, previous: Promise<void> | undefined): () => void {
    let unlock!: () => void;
    const own = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = (previous ?? Promise.resolve()).then(() => own);
    this.tails.set(path, tail);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      // No waiter: make the next same-tick ordinary prompt eligible now, not
      // after a promise-cleanup microtask. A waiter replaces this tail first.
      if (this.tails.get(path) === tail) this.tails.delete(path);
    };
  }

  run<T>(path: string, work: () => Promise<T>): Promise<T> {
    return this.withLease(path, work);
  }

  private async withLease<T>(path: string, work: () => Promise<T>): Promise<T> {
    const release = (await this.acquire(path, true))!;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
