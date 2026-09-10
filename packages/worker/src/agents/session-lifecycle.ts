/** Per-session prompt ownership and serialization for the agent harness. */
export type SessionPhase<End> =
  | { kind: "idle" }
  | { kind: "invoking"; runId: string; settled: boolean }
  | { kind: "terminal-pending"; runId: string; settled: boolean; end: End };

export class SessionLifecycle<End, Message> {
  private phaseValue: SessionPhase<End> = { kind: "idle" };
  private successorRunId: string | undefined;
  private readonly inboxes = new Map<string, Message[]>();
  private operation: Promise<void> = Promise.resolve();
  private readonly terminal = new Map<string, Promise<void>>();
  private readonly resolveTerminal = new Map<string, () => void>();

  phase(): SessionPhase<End> {
    return this.phaseValue;
  }

  owner(): string | undefined {
    return this.phaseValue.kind === "idle" ? undefined : this.phaseValue.runId;
  }

  begin(runId: string): boolean {
    if (this.phaseValue.kind !== "idle") return false;
    this.phaseValue = { kind: "invoking", runId, settled: false };
    return true;
  }

  markSettled(runId: string): void {
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
    return result;
  }

  successor(): string | undefined {
    return this.successorRunId;
  }

  setSuccessor(runId: string | undefined): void {
    this.successorRunId = runId;
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
