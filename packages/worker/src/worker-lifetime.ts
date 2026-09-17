/**
 * One worker's session lifetime: releasing a runtime, and retiring the process
 * (RP-4).
 *
 * The two transitions are the same idea at two scales, so they live together
 * and over one table (`session-runtimes.ts`): close the relevant fence first,
 * let what was already accepted finish, re-evaluate the one canonical predicate
 * under that fence, and then either refuse — leaving everything exactly as it
 * was — or go through with it. Nothing here cancels work, and nothing here
 * queues a request to make a transition possible: a request that arrives while
 * a fence is closed is refused retryably, and its arrival is a reason to refuse
 * the transition rather than something to store.
 *
 * `WorkerServer` keeps the facts (the harness, the tray, the tasks, the namer)
 * and hands them over as one snapshot function; this file owns the transitions.
 */
import {
  ProtocolError,
  SESSION_SAFETY_MAX,
  isSessionWorkPin,
  type SessionPin,
  type SessionSafety,
  type WorkerRetireMode,
  type WorkerRetireRefusal,
} from "@lasercode/protocol";
import { sessionPins, type SessionSafetySnapshot } from "./session-safety.js";
import type { SessionRuntimes } from "./session-runtimes.js";

/**
 * The only sentences a release refusal can carry (RP-4).
 *
 * A pin travels to the host, its diagnostics and its logs, so its detail is
 * written here rather than taken from whatever threw: an engine's message, a
 * filesystem error or a parser's complaint can name a path or quote a
 * conversation, and none of those belong outside this process. Each one is far
 * inside `SESSION_PIN_DETAIL_MAX`.
 */
export const RELEASE_REFUSAL_DETAIL = {
  unprovable: "this runtime cannot prove the conversation can be reopened",
  no_record: "the conversation has no saved record to reopen from",
  identity_mismatch: "the saved record is not this conversation's",
  unreadable: "the saved record cannot be read as it stands",
  flush_failed: "the conversation could not be written out safely",
  close_failed: "this conversation's runtime would not close",
} as const satisfies Record<string, string>;

/** The one sentence for a refusal code this worker does not recognise. */
function refusalDetail(refusal: string | undefined): string {
  const known = RELEASE_REFUSAL_DETAIL as Record<string, string | undefined>;
  return (refusal !== undefined ? known[refusal] : undefined) ?? RELEASE_REFUSAL_DETAIL.unprovable;
}

export type WorkerRetireResult =
  | { retiring: true }
  | { retiring: false; pins: SessionSafety[]; reason: WorkerRetireRefusal };

/** What one live session looks like to the lifetime: enough to release it. */
export interface LifetimeSession {
  path: string;
  closeFailed?: boolean;
  driver: {
    prepareRelease?: () => Promise<{ ok: boolean; refusal?: string; detail?: string }>;
    dispose: () => Promise<void>;
  };
  buffer: { dispose: () => void };
}

export interface WorkerLifetimeDeps<Live extends LifetimeSession> {
  runtimes: SessionRuntimes<Live>;
  /** The one canonical predicate's inputs, gathered by the server. */
  safetySnapshot(live: Live, releasing?: boolean): SessionSafetySnapshot;
  /** The prompt-preflight lease: a release must hold it, like every other move. */
  withFirstTurnLease<T>(path: string, work: () => Promise<T>): Promise<T>;
}

export class WorkerLifetime<Live extends LifetimeSession> {
  constructor(private readonly deps: WorkerLifetimeDeps<Live>) {}

  /**
   * What each loaded session is holding (RP-4), plus whether that list is the
   * whole truth.
   *
   * Sessions being opened or released are listed too, pinned: a session the
   * host believes is there and this answer does not mention would otherwise
   * read as an absence of work when it is really a load in flight. An answer
   * cut at {@link SESSION_SAFETY_MAX} says `complete: false`, and an incomplete
   * answer is never read as "nothing is holding anything".
   */
  safety(): { sessions: SessionSafety[]; complete: boolean } {
    const out: SessionSafety[] = [];
    let complete = true;
    const add = (row: SessionSafety): void => {
      if (out.length >= SESSION_SAFETY_MAX) {
        complete = false;
        return;
      }
      out.push(row);
    };
    for (const live of this.deps.runtimes.values()) add({ path: live.path, pins: sessionPins(this.deps.safetySnapshot(live)) });
    const listed = new Set(out.map((row) => row.path));
    for (const path of this.deps.runtimes.openPaths()) {
      if (!listed.has(path)) {
        add({ path, pins: [{ kind: "opening", detail: "a load has not answered yet" }] });
        listed.add(path);
      }
    }
    for (const path of this.deps.runtimes.releasingPaths()) {
      if (!listed.has(path)) {
        add({ path, pins: [{ kind: "opening", detail: "a release has not finished yet" }] });
        listed.add(path);
      }
    }
    return { sessions: out, complete };
  }

  /**
   * Release one session's runtime, or refuse with the reasons (RP-4).
   *
   * Nothing is cancelled: if anything at all is pinning the session the answer
   * is the pin list and the session keeps working exactly as it was. A release
   * disposes the driver, which emits `closed` and drops every per-session table
   * through the one place that owns that list.
   */
  async unload(path: string): Promise<{ unloaded: boolean; pins: SessionPin[] }> {
    const live = this.deps.runtimes.get(path);
    // Not held here at all: idempotent, and never an error. The host may be
    // acting on bookkeeping a crash recovery already changed.
    if (!live) return { unloaded: false, pins: [] };
    const pins = sessionPins(this.deps.safetySnapshot(live));
    if (pins.length > 0) return { unloaded: false, pins };
    try {
      // From here the path is fenced: a request naming this session is refused
      // by admission rather than started, so nothing can begin between the
      // recheck below and the runtime going away. Work already accepted is
      // still counted by `inFlightRequests`, and pins the session.
      return await this.deps.runtimes.withRelease(path, async () => {
        return this.deps.withFirstTurnLease(path, async () => {
          const current = this.deps.runtimes.get(path);
          if (!current) return { unloaded: true, pins: [] };
          // Re-checked under both fences: preflight, a queued message or a
          // handler accepted before the fence may have taken the session
          // between the first check and here.
          const held = sessionPins(this.deps.safetySnapshot(current, true));
          if (held.length > 0) return { unloaded: false, pins: held };
          // Somebody asked for this conversation while the fence was closed.
          // They were refused with a retryable sentence, and this is the other
          // half of that promise: the runtime stays, so their retry lands here.
          const arrivals = (): { unloaded: false; pins: SessionPin[] } | undefined => {
            const arrived = this.deps.runtimes.arrivedDuringRelease(path);
            return arrived > 0
              ? { unloaded: false, pins: [{ kind: "in_flight_request", detail: `${arrived} request(s) arrived while this was being put to sleep` }] }
              : undefined;
          };
          const early = arrivals();
          if (early) return early;
          // And the conversation has to be reachable without this runtime.
          const readiness = await current.driver.prepareRelease?.();
          if (!readiness) {
            return { unloaded: false, pins: [{ kind: "no_record" as const, detail: RELEASE_REFUSAL_DETAIL.unprovable }] };
          }
          if (!readiness.ok) {
            const kind = readiness.refusal === "flush_failed" ? ("close_failed" as const) : ("no_record" as const);
            // Categorical, and ours: a driver's refusal names a case, and the
            // sentence a person or a log could see is written here. Nothing an
            // engine, a filesystem or a file's contents produced crosses this
            // boundary — a path or a fragment of a conversation in a pin would
            // travel to the host, its diagnostics and its logs.
            return { unloaded: false, pins: [{ kind, detail: refusalDetail(readiness.refusal) }] };
          }
          // Checked again after proving reopenability, because that step reads
          // the record and a request can arrive while it does. Past this line
          // the runtime is going: an arrival is still refused retryably, and
          // the retry opens the conversation again rather than finding it.
          const late = arrivals();
          if (late) return late;
          // The replay suffix is **not** released here. Disposing the driver is
          // what ends the session, and the `closed` event it emits is the one
          // place that drops everything this worker held for it, replay
          // included. Releasing first would leave a session that failed to
          // close still serving a person with no replay to answer a reconnect
          // — bytes the worker would also have stopped accounting for.
          try {
            await current.driver.dispose();
          } catch {
            // Partial failure, decided from the table rather than guessed: the
            // driver's `closed` event is what drops a session here, so if the
            // path is gone the runtime really was released and the throw was a
            // late cleanup. If it is still there, the session keeps being
            // served — with its replay intact — and the failure is reported as
            // a refusal. The thrown value itself stays here: it is an engine's
            // words, and those can carry a path or a fragment of a transcript.
            if (this.deps.runtimes.has(path)) {
              // Remembered, not just reported: a runtime that would not close
              // is degraded, and both a later release and retirement of the
              // whole worker must keep refusing while it is still serving.
              current.closeFailed = true;
              return { unloaded: false, pins: [{ kind: "close_failed" as const, detail: RELEASE_REFUSAL_DETAIL.close_failed }] };
            }
            return { unloaded: true, pins: [] };
          }
          this.deps.runtimes.drop(path);
          return { unloaded: true, pins: [] };
        });
      });
    } catch (error) {
      // A release that could not even take its own fence (one was already
      // running) is not a release. Nothing was disposed.
      if (error instanceof ProtocolError) return { unloaded: false, pins: [] };
      throw error;
    }
  }

  /**
   * Retire this whole worker, atomically (RP-4).
   *
   * The fence closes **synchronously**, before this function's first await, so
   * from the moment the request is dispatched no other request can be admitted:
   * one that arrives is refused and counted, and its arrival is itself a reason
   * to refuse retirement, because the caller will retry and must find a worker.
   * Then accepted handlers drain, the same canonical predicate is re-evaluated
   * under the fence, and the answer is either a refusal that reopens admission
   * or an acknowledgement after which admission never reopens.
   *
   * `automatic` (the idle sweep) refuses on any pin at all. `explicit` (a
   * person stopping this project's worker, or a Feature toggle restarting it)
   * refuses on the pins that name work in flight; advisory pins are moments,
   * not work. The legacy tool-label advisory remains protocol vocabulary but
   * D-277 no longer produces it.
   */
  async retire(mode: WorkerRetireMode): Promise<WorkerRetireResult> {
    if (this.deps.runtimes.retiring) return { retiring: true };
    // Synchronous: no await may come before this line.
    const fenced = this.deps.runtimes.fence();
    if (!fenced) return { retiring: false, pins: [], reason: "arrived" };
    const drained = await this.deps.runtimes.drain();
    const refuse = (reason: WorkerRetireRefusal, pins: SessionSafety[] = []): WorkerRetireResult => {
      this.deps.runtimes.unfence();
      return { retiring: false, pins, reason };
    };
    if (!drained) return refuse("arrived");
    const safety = this.safety();
    if (!safety.complete) return refuse("incomplete", safety.sessions);
    const blocking = safety.sessions
      .map((session) => ({
        path: session.path,
        pins: session.pins.filter((pin) => (mode === "automatic" ? true : isSessionWorkPin(pin.kind))),
      }))
      .filter((session) => session.pins.length > 0);
    if (blocking.length > 0) return refuse("pinned", blocking);
    // Anything that tried to get in while this was deciding means somebody is
    // about to use this worker again.
    if (this.deps.runtimes.arrivedDuringFence() > 0) return refuse("arrived");
    this.deps.runtimes.acknowledgeRetirement();
    return { retiring: true };
  }
}
