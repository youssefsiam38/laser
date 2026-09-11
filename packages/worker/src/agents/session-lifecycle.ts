/** Per-session prompt ownership and serialization for the agent harness. */
export type SessionPhase<End> =
  | { kind: "idle" }
  | { kind: "invoking"; runId: string; settled: boolean }
  | { kind: "terminal-pending"; runId: string; settled: boolean; end: End };

export type PromptAdmission = "invoke" | "engine-queue" | "local-queue" | "bare-concurrent";

export class SessionLifecycle<End, Message> {
  private phaseValue: SessionPhase<End> = { kind: "idle" };
  private successorRunId: string | undefined;
  private readonly inboxes = new Map<string, Message[]>();
  private operation: Promise<void> = Promise.resolve();
  private readonly terminal = new Map<string, Promise<void>>();
  private readonly resolveTerminal = new Map<string, () => void>();
  /** Native extension invocations registered before an older settled event is observed. */
  private readonly descendants = new Map<string, number>();
  private readonly descendantSettled = new Set<string>();
  /** Exact native epoch for the current owner; absent only for legacy/fake drivers. */
  private readonly invocations = new Map<string, Set<string>>();

  phase(): SessionPhase<End> {
    return this.phaseValue;
  }

  owner(): string | undefined {
    return this.phaseValue.kind === "idle" ? undefined : this.phaseValue.runId;
  }

  /**
   * Cohesive prompt admission: settled unwind and asynchronous preflight stay
   * local; only an explicitly queued prompt while demonstrably streaming may
   * enter the engine queue. A bare concurrent prompt remains the driver's
   * refusal to make.
   */
  admitPrompt(runId: string, message: { local: Message; engine: Message }, input: { streaming: boolean; explicitQueue: boolean }): PromptAdmission {
    if (this.phaseValue.kind === "idle") {
      this.invocations.delete(runId);
      this.phaseValue = { kind: "invoking", runId, settled: false };
      return "invoke";
    }
    if (this.phaseValue.runId !== runId || this.phaseValue.kind === "terminal-pending" || this.phaseValue.settled || !input.streaming) {
      this.enqueue(runId, message.local);
      return "local-queue";
    }
    if (input.explicitQueue) {
      this.enqueue(runId, message.engine);
      return "engine-queue";
    }
    return "bare-concurrent";
  }

  begin(runId: string): boolean {
    if (this.phaseValue.kind !== "idle") return false;
    this.invocations.delete(runId);
    this.phaseValue = { kind: "invoking", runId, settled: false };
    return true;
  }

  /** Bind before native work begins; one run may own nested native epochs. */
  bindInvocation(runId: string, invocation: { id: string; runId?: string }): boolean {
    if (this.owner() !== runId || (invocation.runId !== undefined && invocation.runId !== runId)) return false;
    const owned = this.invocations.get(runId) ?? new Set<string>();
    owned.add(invocation.id);
    this.invocations.set(runId, owned);
    return true;
  }

  /** Exact when the driver supplies epochs; run-scoped fallback keeps alternate drivers working. */
  ownsInvocation(invocation: { id: string; runId?: string }): boolean {
    const owner = this.owner();
    if (!owner || invocation.runId !== owner) return false;
    const current = this.invocations.get(owner);
    return current === undefined || current.has(invocation.id);
  }

  markSettled(runId: string): void {
    if ((this.descendants.get(runId) ?? 0) > 0) {
      this.descendantSettled.add(runId);
      return;
    }
    this.applySettled(runId);
  }

  /**
   * Attach work synchronously, before it waits for server admission. The last
   * descendant promotes the newest observed native-settled boundary to the run.
   */
  registerDescendant(runId: string): () => void {
    this.descendants.set(runId, (this.descendants.get(runId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.descendants.get(runId) ?? 1) - 1;
      if (remaining > 0) {
        this.descendants.set(runId, remaining);
        return;
      }
      this.descendants.delete(runId);
      if (this.descendantSettled.delete(runId)) this.applySettled(runId);
    };
  }

  private applySettled(runId: string): void {
    if (this.phaseValue.kind === "invoking" && this.phaseValue.runId === runId) {
      this.phaseValue = { ...this.phaseValue, settled: true };
    } else if (this.phaseValue.kind === "terminal-pending" && this.phaseValue.runId === runId) {
      this.phaseValue = { ...this.phaseValue, settled: true };
    }
  }

  declareEnd(runId: string, end: End): boolean {
    if (this.phaseValue.kind === "terminal-pending" && this.phaseValue.runId === runId) return false;
    if (this.phaseValue.kind !== "invoking" || this.phaseValue.runId !== runId) return false;
    this.phaseValue = { kind: "terminal-pending", runId, settled: this.phaseValue.settled, end };
    return true;
  }

  end(runId: string): End | undefined {
    return this.phaseValue.kind === "terminal-pending" && this.phaseValue.runId === runId ? this.phaseValue.end : undefined;
  }

  finish(runId: string): { settled: boolean; end: End | undefined } | undefined {
    if (this.phaseValue.kind === "idle" || this.phaseValue.runId !== runId) return undefined;
    const result = {
      settled: this.phaseValue.settled,
      ...(this.phaseValue.kind === "terminal-pending" ? { end: this.phaseValue.end } : { end: undefined }),
    };
    this.phaseValue = { kind: "idle" };
    this.invocations.delete(runId);
    this.descendants.delete(runId);
    this.descendantSettled.delete(runId);
    return result;
  }

  successor(): string | undefined {
    return this.successorRunId;
  }

  /** Preserve first-creator identity and append every later message in order. */
  reserveSuccessor(message: Message, create: () => string): { runId: string; created: boolean } {
    if (this.successorRunId) {
      this.enqueue(this.successorRunId, message);
      return { runId: this.successorRunId, created: false };
    }
    const runId = create();
    this.successorRunId = runId;
    this.enqueue(runId, message);
    return { runId, created: true };
  }

  takeSuccessor(): { runId: string; first: Message | undefined } | undefined {
    const runId = this.successorRunId;
    if (!runId) return undefined;
    this.successorRunId = undefined;
    return { runId, first: this.shift(runId) };
  }

  /**
   * Release the reservation. The inbox stays: whoever ends the run reads it
   * to answer every waiter, then `didTerminate` drops it.
   */
  cancelSuccessor(runId: string): boolean {
    if (this.successorRunId !== runId) return false;
    this.successorRunId = undefined;
    return true;
  }

  enqueue(runId: string, message: Message): void {
    const inbox = this.inboxes.get(runId);
    if (inbox) inbox.push(message);
    else this.inboxes.set(runId, [message]);
  }

  inbox(runId: string): readonly Message[] {
    return this.inboxes.get(runId) ?? [];
  }

  replaceInbox(runId: string, messages: Message[]): void {
    if (messages.length === 0) this.inboxes.delete(runId);
    else this.inboxes.set(runId, messages);
  }

  remove(runId: string, message: Message): void {
    this.replaceInbox(runId, this.inbox(runId).filter((candidate) => candidate !== message));
  }

  nextLocalAfterFence(runId: string, isEngineOwned: (message: Message) => boolean): Message | undefined {
    this.replaceInbox(runId, this.inbox(runId).filter((message) => !isEngineOwned(message)));
    return this.shift(runId);
  }

  shift(runId: string): Message | undefined {
    const inbox = this.inboxes.get(runId);
    const message = inbox?.shift();
    if (inbox?.length === 0) this.inboxes.delete(runId);
    return message;
  }

  clearInbox(runId: string): Message[] {
    const messages = this.inboxes.get(runId) ?? [];
    this.inboxes.delete(runId);
    return messages;
  }

  waitForTerminal(runId: string): Promise<void> {
    let promise = this.terminal.get(runId);
    if (!promise) {
      promise = new Promise<void>((resolve) => this.resolveTerminal.set(runId, resolve));
      this.terminal.set(runId, promise);
    }
    return promise;
  }

  didTerminate(runId: string): void {
    this.resolveTerminal.get(runId)?.();
    this.resolveTerminal.delete(runId);
    this.terminal.delete(runId);
    this.inboxes.delete(runId);
    this.invocations.delete(runId);
    this.descendants.delete(runId);
    this.descendantSettled.delete(runId);
    if (this.successorRunId === runId) this.successorRunId = undefined;
  }

  async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const before = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
