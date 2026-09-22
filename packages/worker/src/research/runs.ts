/**
 * The research runs this worker is holding, and their fleet rows (M21-T26).
 *
 * `docs/research-phase.md` is explicit about what a person gets while a
 * research loop is going: "the budget is visible in the fleet row and the
 * Research header", and "progress is the question tree's states and the
 * budget spent; no percentages, no invented ETA". That means a research loop
 * is a **Command**: one row under the conversation it runs in, one Stop that
 * reaches it, one truthful ending. This registry is that, and it is built on
 * the reviewed pattern the verification runs already follow (M21-T19):
 *
 * - **Every run belongs to a conversation.** A row hangs under a session
 *   this worker is holding, and nothing is published under a path no runtime
 *   serves.
 * - **The row travels the road every Command row travels** (M21-T13): a
 *   `BackgroundTask` published as a `lasercode/task/update` extension
 *   message, into this worker's own task index first and the host's after it,
 *   so the conversation that owns a live research loop is pinned while it
 *   runs and Stop from the row is the ordinary `pi/task/stop`.
 * - **The line is content-free.** The phase comes from an enum and the spend
 *   from four counts, so no question's text and no source's address can reach
 *   the fleet through it.
 *
 * What this registry does *not* do is run anything. The loop is the agent's
 * own turn (D-351: the agent runs the retrieval loop itself), so a run here
 * is opened by the first research tool call of a turn and is over when the
 * loop is: every question resolved, the budget spent, the person's Stop, the
 * turn ended, or the conversation gone. Stopping sets the ledger's stop, so
 * the next tool call is refused with the sentence that tells the model to
 * report what it has — the run ends on a refusal it can report, and every
 * finding already written stays written.
 */
import { isResearchFleetTaskId, researchFleetTaskId, researchRunIdOf, type BackgroundTask } from "@lasercode/protocol";
import type { ResearchLedger } from "./budget.js";
import { ResearchCommand, researchActivityLine, type ResearchPhase } from "./command.js";

/** How many finished runs are kept for a person to read before the oldest goes. */
export const RESEARCH_RUNS_KEPT = 20;

/** How often a live research run refreshes its fleet row. */
export const RESEARCH_ROW_INTERVAL_MS = 250;

/** Which step of the loop each tool is. The four tools are the four steps. */
const PHASE_OF_TOOL: Record<string, ResearchPhase> = {
  search_sources: "retrieving",
  read_source: "reading",
  record_finding: "recording",
  resolve_question: "resolving",
};

/**
 * How a run ended. One value decides the row's status, its reason and whether
 * it has an end at all, so a row can never say *completed* about a run that
 * was stopped.
 */
export type ResearchEnding =
  | { kind: "resolved" }
  | { kind: "budget"; why: string }
  | { kind: "stopped"; why: string }
  | { kind: "turn_ended" }
  /** The conversation that owned it is gone: stopped, and published to nobody. */
  | { kind: "detached"; why: string };

export interface ResearchRunServiceOptions {
  /** Publish one fleet row. Absent in narrow tests. */
  publishTask?: (sessionPath: string, task: BackgroundTask) => void;
  /**
   * Whether this worker is holding that conversation open. A row under a path
   * nobody here serves is a row nobody can find, so a run is not opened for
   * one.
   */
  holdsSession?: (sessionPath: string) => boolean;
  now?: () => number;
  /** One bounded diagnostic line. Never the error itself. Defaults to stderr. */
  log?: (line: string) => void;
}

interface Held {
  command: ResearchCommand;
  ledger: ResearchLedger;
  /** The conversation that owns it, at the address it lives at now. */
  sessionPath: string;
  startedAt: string;
  /** Cut what the adapters are doing right now, on a stop. */
  abort?: (() => void) | undefined;
  /** Research tool calls in flight. A run settles when the last one returns. */
  inflight: number;
  /** What the last `resolve_question` said is still open, when one has. */
  openQuestions?: number;
  publishedAtMs: number;
  publishedPhase?: ResearchPhase;
  /**
   * The last row this run published: its address and its line together.
   *
   * A row that says exactly what the last one said, under the same path,
   * tells nobody anything — and a research loop publishes from two places at
   * once (the command's own progress, and the step that moved it), so the
   * same row would otherwise arrive twice for one call. The address is part
   * of the key because a fork republishes the *same* line at a new path, and
   * that publication is the only way the moved conversation learns the row.
   */
  publishedLine?: string;
  /** The ending has been published and an observer took it. */
  publishedEnding?: boolean;
  /** A stop was accepted while a call was still in flight. */
  stopping?: boolean;
  /** The ending this run is owed, once the call in flight returns. */
  owed?: ResearchEnding;
  /** How it ended. Set once; until then the run is live, whatever the phase. */
  ending?: ResearchEnding;
  /**
   * The conversation that owned it is gone.
   *
   * Nothing more is published for it: a row under a path no runtime serves
   * re-creates that session in this worker's index and in the host's
   * register, and a row nothing will ever terminate is a ghost the fleet
   * cannot lose. The run still stops, still settles and is still pruned —
   * privately, and what it recorded stays recorded.
   */
  detached?: boolean;
}

export class ResearchRunService {
  private readonly runs = new Map<string, Held>();
  /** The live run of each conversation, by its path. One loop at a time. */
  private readonly live = new Map<string, string>();

  constructor(private readonly options: ResearchRunServiceOptions = {}) {}

  /**
   * Run one research tool call inside the run it belongs to.
   *
   * The call itself is untouched: what happens here is the row around it —
   * opened on the first call of a loop, moved to the step this call is,
   * published before the call runs rather than after it, and settled when the
   * loop is over. A call this registry cannot give a row — no conversation, a
   * conversation this worker does not hold, or a loop the ledger has already
   * stopped — is simply awaited, because the alternative is refusing the
   * model's own turn over a row.
   */
  async during<T>(
    input: { sessionPath?: string | undefined; tool: string; ledger: ResearchLedger; abort?: (() => void) | undefined },
    call: () => Promise<T>,
  ): Promise<T> {
    const held = this.enter(input);
    if (!held) return await call();
    try {
      const result = await call();
      this.afterCall(held, input.tool, result);
      return result;
    } finally {
      held.inflight -= 1;
      // The ledger is the authority on whether the loop may spend anything
      // more, whatever this call answered: a refusal *is* how a spent budget
      // and a stop arrive.
      this.readLedger(held);
      this.drain(held);
    }
  }

  /**
   * A person's stop, by run id.
   *
   * `stopped` answers one question only — did this stop change anything — so
   * a run that had already ended answers `false` and is left exactly as it
   * was. The stop reaches the ledger, so the next tool call is refused with
   * the sentence that tells the model to report what it has, and it reaches
   * the adapters through `abort`, so a fetch already in the air stops too.
   * Nothing recorded is deleted: a stopped research keeps every finding it
   * had already written.
   */
  stop(input: { runId: string; reason?: string }): { stopped: boolean } {
    const held = this.runs.get(input.runId);
    if (!held || held.ending !== undefined) return { stopped: false };
    const why = input.reason ?? "you stopped it";
    held.stopping = true;
    held.command.stop(why);
    this.abort(held);
    const ending: ResearchEnding = { kind: "stopped", why };
    if (held.inflight > 0) {
      held.owed = ending;
      this.publish(input.runId, true);
    } else {
      this.settle(input.runId, ending);
    }
    return { stopped: true };
  }

  /**
   * Stop from the fleet's own row. Answers whether this worker **holds** that
   * id — which is what `delivered` means everywhere else in the fleet, and is
   * deliberately not "the run was ended": a run that had already finished was
   * still found here, and answering `false` for it would tell a person nobody
   * holds a Command they can see in their own fleet.
   */
  stopByTaskId(fleetTaskId: string): boolean {
    if (!isResearchFleetTaskId(fleetTaskId)) return false;
    const runId = researchRunIdOf(fleetTaskId);
    if (!this.runs.has(runId)) return false;
    this.stop({ runId });
    return true;
  }

  /**
   * The turn this loop was running in has ended.
   *
   * The honest end of a research loop that neither resolved everything nor
   * spent its budget: the agent's turn is over, so the loop is over too, and
   * the row says how far it got instead of staying `running` for ever under a
   * conversation nobody is working in. A later turn that goes back to the
   * research opens the next run, with the same ledger, so the spend a row
   * shows is always this research's own total.
   */
  turnEnded(sessionPath: string): void {
    const runId = this.live.get(sessionPath);
    if (runId === undefined) return;
    const held = this.runs.get(runId);
    if (!held || held.ending !== undefined) return;
    if (held.inflight > 0) {
      held.owed ??= { kind: "turn_ended" };
      return;
    }
    this.settle(runId, { kind: "turn_ended" });
  }

  /**
   * The conversation this run belongs to has moved its file (a fork).
   *
   * The owner is unchanged: the same conversation owns the same run, and only
   * its address moved. A live run republishes once under the new path — a row
   * is only ever learnt from a publication — and the old path is never named
   * again, because the run's own record is the single source the row reads.
   */
  rekeySession(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const moved: string[] = [];
    for (const [runId, held] of this.runs) {
      if (held.sessionPath !== oldPath) continue;
      held.sessionPath = newPath;
      if (held.ending === undefined && held.detached !== true) moved.push(runId);
    }
    const liveRun = this.live.get(oldPath);
    if (liveRun !== undefined) {
      this.live.delete(oldPath);
      this.live.set(newPath, liveRun);
    }
    for (const runId of moved) this.publish(runId, true);
  }

  /**
   * The conversation that owned these runs is gone.
   *
   * Its runtime closed — expectedly or not — so nothing can watch or stop
   * them there any more, and a row published under that path would resurrect
   * a session this worker has already let go. So: stop them, publish nothing
   * further, and let them settle and be pruned privately. A write already in
   * flight still finishes, and what it wrote is still written.
   */
  sessionClosed(sessionPath: string, reason = "the conversation it was running in was closed"): void {
    for (const [runId, held] of this.runs) {
      if (held.sessionPath !== sessionPath || held.ending !== undefined) continue;
      held.detached = true;
      held.stopping = true;
      held.command.stop(reason);
      this.abort(held);
      const ending: ResearchEnding = { kind: "detached", why: reason };
      if (held.inflight > 0) held.owed = ending;
      else this.settle(runId, ending);
    }
    this.live.delete(sessionPath);
  }

  /** True while a run this conversation owns has not settled. */
  hasUnsettled(sessionPath: string): boolean {
    for (const held of this.runs.values()) {
      if (held.ending === undefined && held.sessionPath === sessionPath) return true;
    }
    return false;
  }

  /**
   * Work this worker still owes, by the conversation that owns it.
   *
   * The identities, not a count, for the same reason the verification
   * registry answers identities (M21-T19): the caller has to tell owed work
   * apart from work its own fleet index is already pinning the session for,
   * and a number cannot be deduplicated. A run whose conversation closed
   * unexpectedly is in this list — detaching it stopped the *publishing*, not
   * the write it may still be finishing — which is what keeps this process
   * from ending in the middle of a project's own record.
   */
  unsettledWork(): Array<{ sessionPath: string; taskIds: string[] }> {
    const byPath = new Map<string, string[]>();
    for (const [runId, held] of this.runs) {
      if (held.ending !== undefined) continue;
      const owed = byPath.get(held.sessionPath);
      if (owed) owed.push(researchFleetTaskId(runId));
      else byPath.set(held.sessionPath, [researchFleetTaskId(runId)]);
    }
    return [...byPath].map(([sessionPath, taskIds]) => ({ sessionPath, taskIds }));
  }

  // ----------------------------------------------------------------- inside

  /** The run this call belongs to, opening one if the loop just started. */
  private enter(input: {
    sessionPath?: string | undefined;
    tool: string;
    ledger: ResearchLedger;
    abort?: (() => void) | undefined;
  }): Held | undefined {
    const phase = PHASE_OF_TOOL[input.tool];
    if (phase === undefined) return undefined;
    const sessionPath = input.sessionPath;
    if (sessionPath === undefined || sessionPath.trim() === "") return undefined;
    if (this.options.holdsSession && !this.options.holdsSession(sessionPath)) return undefined;
    const existingId = this.live.get(sessionPath);
    const existing = existingId !== undefined ? this.runs.get(existingId) : undefined;
    if (existing && existing.ending === undefined) {
      existing.inflight += 1;
      // A phase change always gets a row: the step is the only progress a
      // research loop has, so it is never throttled away.
      existing.command.advance(phase);
      this.publish(existingId!, true);
      return existing;
    }
    // A loop the ledger has already ended does not get a second row: the
    // refusal the next call receives is the answer, and a row for it would be
    // a Command that never started.
    if (input.ledger.stopped() !== undefined) return undefined;
    const startedAt = new Date(this.now()).toISOString();
    let held: Held | undefined;
    const command = new ResearchCommand({
      ledger: input.ledger,
      onProgress: () => {
        if (held) this.publish(held.command.id);
      },
    });
    held = {
      command,
      ledger: input.ledger,
      sessionPath,
      startedAt,
      abort: input.abort,
      inflight: 1,
      publishedAtMs: 0,
    };
    this.runs.set(command.id, held);
    this.live.set(sessionPath, command.id);
    this.prune();
    // The first row a person sees is a running one, published before the call
    // it describes rather than after it.
    command.advance(phase);
    this.publish(command.id, true);
    return held;
  }

  /** What one call told this run about the loop's own state. */
  private afterCall(held: Held, tool: string, result: unknown): void {
    if (tool !== "resolve_question") return;
    const open = (result as { openQuestions?: unknown } | undefined)?.openQuestions;
    if (typeof open !== "number" || !Number.isFinite(open) || open < 0) return;
    held.openQuestions = Math.floor(open);
    // Every question resolved is the contract's own end of the loop
    // (`docs/research-phase.md`, step 7).
    if (held.openQuestions === 0 && held.ending === undefined) held.owed ??= { kind: "resolved" };
  }

  /** The ledger's own last word: a spent budget, or a stop. */
  private readLedger(held: Held): void {
    if (held.ending !== undefined || held.owed !== undefined) return;
    const why = held.ledger.stopped();
    if (why === undefined) return;
    held.owed = held.stopping === true ? { kind: "stopped", why } : { kind: "budget", why };
  }

  /** Publish where this run got to, and settle it when nothing is in flight. */
  private drain(held: Held): void {
    const runId = held.command.id;
    if (held.ending !== undefined) return;
    if (held.inflight > 0) {
      this.publish(runId);
      return;
    }
    if (held.owed !== undefined) {
      this.settle(runId, held.owed);
      return;
    }
    this.publish(runId, true);
  }

  private abort(held: Held): void {
    try {
      held.abort?.();
    } catch {
      // Cutting the adapters is a courtesy: the ledger's stop is what ends
      // the loop, and it has already been set.
    }
  }

  /**
   * One run has ended: say so, then bound what is kept.
   *
   * The order is the point. The terminal row goes out while the run is still
   * held, so nothing can be forgotten between a run ending and a person being
   * told how it ended — and only then does this run count as finished for
   * retention.
   */
  private settle(runId: string, ending: ResearchEnding): void {
    const held = this.runs.get(runId);
    if (!held || held.ending !== undefined) return;
    held.ending = ending;
    held.command.advance(ending.kind === "stopped" || ending.kind === "detached" ? "stopped" : "done");
    try {
      this.publish(runId, true);
    } catch {
      // Publication is somebody else's code twice over — the observer and its
      // diagnostic — and both are guarded below. This is the last lock on the
      // same door: whatever happens out there, a run that has ended is
      // finished here and retention still runs.
    }
    if (this.live.get(held.sessionPath) === runId) this.live.delete(held.sessionPath);
    this.prune();
  }

  /** One fleet row, in the vocabulary a Command row already has. */
  private publish(runId: string, force = false): void {
    const held = this.runs.get(runId);
    if (!held || !this.options.publishTask || held.detached === true) return;
    const ending = held.ending;
    const terminal = ending !== undefined;
    if (terminal && held.publishedEnding === true) return;
    const at = this.now();
    const progress = held.command.progress();
    if (!force && !terminal && progress.phase === held.publishedPhase && at - held.publishedAtMs < RESEARCH_ROW_INTERVAL_MS) return;
    const activity = researchActivityLine(progress, !terminal && held.stopping === true);
    const line = `${held.sessionPath}\u0000${activity}`;
    if (!terminal && line === held.publishedLine) return;
    held.publishedAtMs = at;
    held.publishedPhase = progress.phase;
    held.publishedLine = line;
    const task: BackgroundTask = {
      id: researchFleetTaskId(runId),
      sessionPath: held.sessionPath,
      // No question text and no source address, here or anywhere else on the
      // row: the research itself is read in the workspace, where a person can
      // see its questions, its findings and their sources.
      command: "Research",
      title: "Research",
      status: terminal ? rowStatus(ending) : "running",
      origin: "background",
      startedAt: held.startedAt,
      // A research run's output is its findings, which are in the project's
      // own record; the row carries none of it, so it never pretends to be a
      // log.
      outputBytes: 0,
      activity,
      ...(terminal ? { endedAt: new Date(at).toISOString(), exitCode: null, terminalReason: endingReason(ending, held) } : {}),
    };
    try {
      this.options.publishTask(held.sessionPath, task);
      if (terminal) held.publishedEnding = true;
    } catch (error) {
      // An observer that threw has lost this row. Nothing is retried and
      // nothing is queued — this registry cannot promise anyone else's
      // delivery — but it must not lose the run itself, so settlement and
      // retention carry on and one bounded line says a row went missing: the
      // run's id and the error's *kind*, never its message, its stack, a
      // question, a source or a byte of anything that was read.
      const kind = error instanceof Error ? error.name.slice(0, 80) : typeof error;
      this.note(`a research run's row could not be published for ${runId} (${kind}); its fleet row may be missing`);
    }
  }

  /**
   * One bounded diagnostic line, through an observer that is not trusted
   * either: it is only ever reached because the row observer already failed,
   * and a diagnostic never decides whether work settles.
   */
  private note(line: string): void {
    try {
      (this.options.log ?? ((text: string) => console.error(text)))(line);
    } catch {
      // Nothing left to say it with, and nothing here depends on having said
      // it. The run's own state is unaffected.
    }
  }

  /**
   * Forget the oldest settled runs past the bound.
   *
   * Insertion order is start order, so the oldest settled run goes first. A
   * run that has not settled is never evicted however many there are: it is
   * still working, and forgetting it would lose the only handle a person has
   * on it.
   */
  private prune(): void {
    const settled = [...this.runs.entries()].filter(([, held]) => held.ending !== undefined);
    for (let index = 0; index < settled.length - RESEARCH_RUNS_KEPT; index += 1) {
      this.runs.delete(settled[index]![0]);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** The row's status. One ending, one status; never inferred from a phase. */
function rowStatus(ending: ResearchEnding): BackgroundTask["status"] {
  return ending.kind === "stopped" || ending.kind === "detached" ? "stopped" : "completed";
}

/** Why the run ended, in the sentence a person reads on the terminal row. */
function endingReason(ending: ResearchEnding, held: Held): string {
  const spent = `Spent: ${held.ledger.line()}.`;
  const open = held.openQuestions;
  const remaining = open !== undefined && open > 0 ? ` ${String(open)} question${open === 1 ? "" : "s"} still open.` : "";
  switch (ending.kind) {
    case "resolved":
      return `Every question is resolved. ${spent}`;
    case "budget":
      return `${capitalise(ending.why)}.${remaining} ${spent}`;
    case "stopped":
      return `${capitalise(ending.why)} — the findings it had already recorded are kept.${remaining} ${spent}`;
    case "detached":
      return `${capitalise(ending.why)} — what it had already recorded is kept.${remaining} ${spent}`;
    case "turn_ended":
      return `The turn this research ran in ended.${remaining} ${spent}`;
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
