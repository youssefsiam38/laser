/**
 * The one predicate that decides whether a session's runtime may be released
 * (RP-4).
 *
 * It is pure: the worker gathers a snapshot of what it already holds and this
 * turns that snapshot into pins, in a stable order, with a short detail for a
 * diagnostic. Two consumers, one answer:
 *
 * - `pi/session/unload` refuses unless the list is empty;
 * - `pi/worker/safety` reports the list, and the host's pool asks for it before
 *   automatic retirement, so nothing automatic is ever less careful than
 *   unload (`packages/host/src/worker-pool.ts`).
 *
 * Nothing here stops, answers, dequeues or truncates anything. A pin is a
 * refusal, and the work it names keeps running exactly as it was.
 */
import { SESSION_PIN_DETAIL_MAX, type SessionPin, type SessionPinKind } from "@lasercode/protocol";

/**
 * Everything the worker knows about one loaded session that a release would
 * destroy. Counts rather than booleans wherever the number is worth saying in
 * a diagnostic; every field is read from state the worker already has.
 */
export interface SessionSafetySnapshot {
  /** A `session/load` for this path has not answered yet. */
  opening: boolean;
  /** Requests naming this session that are being served right now. */
  inFlightRequests: number;
  /** A turn is running (a fallback switch between engine runs counts). */
  streaming: boolean;
  compacting: boolean;
  /** First-turn preflight holds the session, or a speculative runtime does. */
  firstTurn: boolean;
  /** Extension questions waiting for a person (no tool call behind them). */
  questions: number;
  /** Tool approvals waiting for a person. */
  approvals: number;
  /** Non-terminal agent runs executing in this session. */
  liveRuns: number;
  /** Non-terminal agent runs of children whose parent is this session. */
  liveChildRuns: number;
  /** Queued steering/follow-up work: the engine's queue and the harness's. */
  queuedWork: number;
  /** Messages in the person's pending tray, which lives only in memory. */
  trayMessages: number;
  /** Foreground or background commands of this session that are running. */
  runningTasks: number;
  /**
   * Naming this session is under way: a bounded model completion for its first
   * prompt is in flight, and it ends in a rename through this runtime.
   *
   * A prompt merely parked because no naming model was connected is **not** a
   * pin: nothing can perform that intent, so the refusal would have no end,
   * and a runtime kept for the life of the worker is a worse loss than an
   * untitled conversation. The parked words are kept, so the pin appears if a
   * model arrives and the naming actually starts.
   */
  naming: boolean;
  /**
   * There is a durable record to reopen from. False means releasing the runtime
   * would lose the conversation, so it is pinned however idle it is.
   */
  hasRecord: boolean;
  /**
   * A release already tried to close this runtime and could not. The
   * conversation is still being served by it, so nothing may end it — not a
   * later release, and not retirement of the whole worker.
   *
   * A flag, deliberately: whatever the engine said about the failure stays
   * inside the worker, because an engine's words can name a path or quote a
   * conversation and a pin is read by the host, its diagnostics and its logs.
   */
  closeFailed?: boolean;
}

function pin(kind: SessionPinKind, detail?: string): SessionPin {
  if (detail === undefined) return { kind };
  const flat = detail.replace(/\s+/g, " ").trim();
  if (!flat) return { kind };
  return { kind, detail: flat.length > SESSION_PIN_DETAIL_MAX ? flat.slice(0, SESSION_PIN_DETAIL_MAX) : flat };
}

/**
 * The pins holding this session, or an empty list when its runtime is safe to
 * release. Order is stable so a diagnostic reads the same way twice.
 */
export function sessionPins(snapshot: SessionSafetySnapshot): SessionPin[] {
  const pins: SessionPin[] = [];
  if (snapshot.opening) pins.push(pin("opening", "a load has not answered yet"));
  if (snapshot.inFlightRequests > 0) pins.push(pin("in_flight_request", `${snapshot.inFlightRequests} request(s) in flight`));
  if (snapshot.streaming) pins.push(pin("streaming", "a turn is running"));
  if (snapshot.compacting) pins.push(pin("compacting", "history is being compacted"));
  if (snapshot.firstTurn) pins.push(pin("first_turn", "first-turn preflight holds this session"));
  if (snapshot.questions > 0) pins.push(pin("question", `${snapshot.questions} question(s) waiting`));
  if (snapshot.approvals > 0) pins.push(pin("approval", `${snapshot.approvals} approval(s) waiting`));
  if (snapshot.liveRuns > 0) pins.push(pin("agent_run", `${snapshot.liveRuns} run(s) have not ended`));
  if (snapshot.liveChildRuns > 0) pins.push(pin("child_run", `${snapshot.liveChildRuns} child run(s) have not ended`));
  if (snapshot.queuedWork > 0) pins.push(pin("queued_work", `${snapshot.queuedWork} queued message(s)`));
  if (snapshot.trayMessages > 0) pins.push(pin("pending_tray", `${snapshot.trayMessages} message(s) waiting in the tray`));
  if (snapshot.runningTasks > 0) pins.push(pin("task", `${snapshot.runningTasks} command(s) running`));
  if (snapshot.naming) pins.push(pin("naming", "this session is being named"));
  if (!snapshot.hasRecord) pins.push(pin("no_record", "there is no durable record to reopen from"));
  if (snapshot.closeFailed) pins.push(pin("close_failed", "this conversation's runtime would not close"));
  return pins;
}
