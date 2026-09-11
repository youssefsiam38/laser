/** Per-session prompt ownership and serialization for the agent harness. */
export type SessionPhase<End> =
  | { kind: "idle" }
  | { kind: "invoking"; runId: string; settled: boolean }
  | { kind: "terminal-pending"; runId: string; settled: boolean; end: End };

export type PromptAdmission = "invoke" | "engine-queue" | "local-queue" | "bare-concurrent";

export type InvocationBoundary<End> = { settled: boolean; end: End | undefined };
export type InvocationFinish<End> = InvocationBoundary<End> | { fenced: true };
export type InvocationControlKind = "interrupt" | "stop";
export type InvocationControlOutcome = { ok: true } | { ok: false; error: string; cancelled?: boolean };
export interface InvocationControlTicket {
  token: number;
  created: boolean;
  outcome: Promise<InvocationControlOutcome>;
}
export type InvocationControlTransition<End, Invocation, Context> =
  | { kind: "pending" }
  | { kind: "retry"; token: number }
  | { kind: "failed"; control: InvocationControlKind; token: number; context: Context; finished?: { boundary: InvocationBoundary<End>; invocation: Invocation } }
  | { kind: "ready"; control: InvocationControlKind; token: number; context: Context };

interface InvocationControl<End, Invocation, Context> {
  runId: string;
  token: number;
  kind: InvocationControlKind;
  context: Context;
  phase: "requested" | "aborting" | "awaiting-execution" | "ready" | "controlled";
  waitForExecution: boolean;
  executionStarted: boolean;
  abortAttempt?: "initial" | "execution";
  finished?: { boundary: InvocationBoundary<End>; invocation: Invocation };
  outcome: Promise<InvocationControlOutcome>;
  resolve: (outcome: InvocationControlOutcome) => void;
}

export class SessionLifecycle<End, Message, Invocation = unknown, Context = undefined> {
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
  /** One typed interrupt/stop transaction owns cancellation and the prompt fence. */
  private controlValue: InvocationControl<End, Invocation, Context> | undefined;
  private controlSerial = 0;
  /** Every portable dialog accepted under the current exact owner, not only the projected oldest question. */
  private readonly dialogs = new Map<string, Map<string, string | undefined>>();

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

  /** Hold the engine-ready boundary while a typed interrupt/stop transaction is unresolved. */
  finish(runId: string, invocation: Invocation): InvocationFinish<End> | undefined {
    if (this.phaseValue.kind === "idle" || this.phaseValue.runId !== runId) return undefined;
    const boundary: InvocationBoundary<End> = {
      settled: this.phaseValue.settled,
      ...(this.phaseValue.kind === "terminal-pending" ? { end: this.phaseValue.end } : { end: undefined }),
    };
    const control = this.controlValue;
    if (control?.runId === runId && control.phase !== "controlled") {
      control.finished = { boundary, invocation };
      return { fenced: true };
    }
    this.releaseOwner(runId);
    return boundary;
  }

  beginInterrupt(runId: string, input: { waitForExecution: boolean; context: Context }): InvocationControlTicket | undefined {
    if (this.owner() !== runId) return undefined;
    const current = this.controlValue;
    if (current?.runId === runId) {
      if (current.kind !== "interrupt") return undefined;
      return { token: current.token, created: false, outcome: current.outcome };
    }
    return this.createControl(runId, "interrupt", input);
  }

  /** Direct stop starts one control; promotion keeps its fence and refuses only an unresolved interrupt ticket. */
  beginStop(
    runId: string,
    input: { waitForExecution: boolean; context: Context; interruptOutcome: InvocationControlOutcome },
  ): (InvocationControlTicket & { refusedInterruptToken?: number }) | undefined {
    if (this.owner() !== runId) return undefined;
    const current = this.controlValue;
    if (!current) return this.createControl(runId, "stop", input);
    if (current.runId !== runId) return undefined;
    if (current.kind === "stop") return { token: current.token, created: false, outcome: current.outcome };
    const refusedInterruptToken = current.phase === "controlled" ? undefined : current.token;
    if (refusedInterruptToken !== undefined) current.resolve(input.interruptOutcome);
    let resolve!: (outcome: InvocationControlOutcome) => void;
    const outcome = new Promise<InvocationControlOutcome>((settle) => { resolve = settle; });
    current.kind = "stop";
    current.context = input.context;
    current.waitForExecution ||= input.waitForExecution;
    current.outcome = outcome;
    current.resolve = resolve;
    if (current.phase === "controlled" || current.phase === "ready") current.phase = "requested";
    return {
      token: current.token,
      created: true,
      outcome,
      ...(refusedInterruptToken !== undefined ? { refusedInterruptToken } : {}),
    };
  }

  control(runId: string): { token: number; kind: InvocationControlKind; outcome: Promise<InvocationControlOutcome> } | undefined {
    const control = this.controlValue;
    return control?.runId === runId ? { token: control.token, kind: control.kind, outcome: control.outcome } : undefined;
  }

  /** Transition one allowed abort attempt to in-flight. */
  startAbort(runId: string, token: number, attempt: "initial" | "execution"): boolean {
    const control = this.controlValue;
    if (!control || control.runId !== runId || control.token !== token) return false;
    if (control.phase === "aborting" || control.phase === "ready" || control.phase === "controlled") return false;
    if (attempt === "execution") control.executionStarted = true;
    control.phase = "aborting";
    control.abortAttempt = attempt;
    return true;
  }

  /** A stamped execution event either arms the current attempt or asks the harness to abort now. */
  executionStarted(runId: string): { token: number } | undefined {
    const control = this.controlValue;
    if (!control || control.runId !== runId || control.phase === "ready" || control.phase === "controlled") return undefined;
    control.executionStarted = true;
    if (control.phase !== "awaiting-execution") return undefined;
    control.phase = "requested";
    return { token: control.token };
  }

  /** Feed one abort result back into the transaction; only `ready` may be committed. */
  settleAbort(runId: string, token: number, outcome: { ok: true } | { ok: false; error: string }): InvocationControlTransition<End, Invocation, Context> {
    const control = this.controlValue;
    if (!control || control.runId !== runId || control.token !== token || control.phase !== "aborting") return { kind: "pending" };
    const attempt = control.abortAttempt ?? "initial";
    delete control.abortAttempt;
    if (!outcome.ok) {
      const finished = control.finished;
      control.resolve({ ok: false, error: outcome.error });
      this.controlValue = undefined;
      if (finished) this.releaseOwner(runId);
      return { kind: "failed", control: control.kind, token, context: control.context, ...(finished ? { finished } : {}) };
    }
    if (control.waitForExecution && attempt === "initial" && !control.finished) {
      if (control.executionStarted) {
        control.phase = "requested";
        return { kind: "retry", token };
      }
      control.phase = "awaiting-execution";
      return { kind: "pending" };
    }
    control.phase = "ready";
    return { kind: "ready", control: control.kind, token, context: control.context };
  }

  /** Commit cancellation effects only after abort control is ready. */
  commitControl(runId: string, token: number): { boundary: InvocationBoundary<End>; invocation: Invocation } | undefined {
    const control = this.controlValue;
    if (!control || control.runId !== runId || control.token !== token || control.phase !== "ready") return undefined;
    control.phase = "controlled";
    control.resolve({ ok: true });
    const finished = control.finished;
    if (!finished) return undefined;
    const boundary: InvocationBoundary<End> = {
      settled: this.phaseValue.kind !== "idle" ? this.phaseValue.settled : finished.boundary.settled,
      ...(this.phaseValue.kind === "terminal-pending" ? { end: this.phaseValue.end } : { end: finished.boundary.end }),
    };
    this.releaseOwner(runId);
    return { boundary, invocation: finished.invocation };
  }

  private createControl(runId: string, kind: InvocationControlKind, input: { waitForExecution: boolean; context: Context }): InvocationControlTicket {
    const token = ++this.controlSerial;
    let resolve!: (outcome: InvocationControlOutcome) => void;
    const outcome = new Promise<InvocationControlOutcome>((settle) => { resolve = settle; });
    this.controlValue = {
      runId,
      token,
      kind,
      context: input.context,
      phase: "requested",
      waitForExecution: input.waitForExecution,
      executionStarted: false,
      outcome,
      resolve,
    };
    return { token, created: true, outcome };
  }

  /** Track all dialogs under the exact current invocation, and cancel new ones while controlled. */
  recordDialog(runId: string, id: string, invocationId?: string): { cancel: boolean } {
    const owner = this.owner();
    if (owner !== undefined && owner !== runId) return { cancel: false };
    const owned = this.dialogs.get(runId) ?? new Map<string, string | undefined>();
    owned.set(id, invocationId);
    this.dialogs.set(runId, owned);
    return { cancel: this.controlValue?.runId === runId };
  }

  resolveDialog(runId: string, id: string): void {
    const owned = this.dialogs.get(runId);
    owned?.delete(id);
    if (owned?.size === 0) this.dialogs.delete(runId);
  }

  ownedDialogs(runId: string, pendingIds?: ReadonlySet<string>): string[] {
    const owned = this.dialogs.get(runId);
    if (!owned) return [];
    const ids = [...owned.keys()].filter((id) => pendingIds === undefined || pendingIds.has(id));
    if (pendingIds) {
      for (const id of [...owned.keys()]) if (!pendingIds.has(id)) owned.delete(id);
    }
    return ids;
  }

  private releaseOwner(runId: string): void {
    this.phaseValue = { kind: "idle" };
    this.invocations.delete(runId);
    this.descendants.delete(runId);
    this.descendantSettled.delete(runId);
    this.dialogs.delete(runId);
    if (this.controlValue?.runId === runId) this.controlValue = undefined;
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

  /** Append to the stable priority prefix, preserving FIFO within both groups. */
  enqueuePriority(runId: string, message: Message, isPriority: (candidate: Message) => boolean): void {
    const inbox = [...this.inbox(runId)];
    const firstOrdinary = inbox.findIndex((candidate) => !isPriority(candidate));
    inbox.splice(firstOrdinary < 0 ? inbox.length : firstOrdinary, 0, message);
    this.inboxes.set(runId, inbox);
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
    this.dialogs.delete(runId);
    if (this.controlValue?.runId === runId) {
      this.controlValue.resolve({ ok: false, error: "The agent session ended before cancellation control settled." });
      this.controlValue = undefined;
    }
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
