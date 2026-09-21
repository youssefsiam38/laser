/**
 * Transport pressure (RP-7): who owns which bytes, and what happens at the
 * mark.
 *
 * Every number here is **UTF-8 bytes**, and every queue has exactly one owner
 * so no byte is counted twice. The rules the constants encode:
 *
 * - **Nothing that carries state is ever dropped.** Session updates, questions,
 *   attention, tasks, runs and terminal frames fence the connection — it is
 *   closed, and the peer's normal reconnect re-reads them authoritatively —
 *   rather than disappearing out of a queue. There is no second resume path
 *   (`docs/security.md` §7): a fenced peer keeps nothing queued.
 * - **Only a notification a client can read back may be shed**, and each one
 *   that may is explicitly re-readable by a request the client already makes.
 *   The list is short on purpose and grows only with a message whose whole
 *   truth another request already returns.
 * - **A command is never cancelled, paused or throttled** by any of this.
 *   Backpressure shapes what a *diagnostic* costs, never what work runs.
 */
import type { HostNotifications } from "./messages.js";

// ---------------------------------------------------------------------------
// Provider captures (worker → host)
// ---------------------------------------------------------------------------

/**
 * A capture at or below this size crosses as one ordinary extension message,
 * exactly as it always has. Above it, it is chunked.
 */
export const CAPTURE_CHUNKED_ABOVE_BYTES = 1024 * 1024;

/** One chunk frame's payload. Four pipe chunks; small next to any ceiling. */
export const CAPTURE_CHUNK_BYTES = 256 * 1024;

/**
 * The largest capture whose body is carried at all. A bigger one is recorded
 * with its exact size, digest and reason, and no body — never truncated into
 * something that reads like a complete request.
 */
export const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;

/** Worker → host pipe backlog above which a capture is recorded without its body. */
export const WORKER_PIPE_SOFT_BYTES = 8 * 1024 * 1024;

/** Every open capture on the host, across every worker and session. */
export const CAPTURE_ACCUM_GLOBAL_BYTES = 48 * 1024 * 1024;
/** Every open capture from one worker generation. */
export const CAPTURE_ACCUM_ACTOR_BYTES = 32 * 1024 * 1024;
/** Open captures for one session: one accepted capture plus its envelope. */
export const CAPTURE_ACCUM_SESSION_BYTES = 17 * 1024 * 1024;
/** Captures open at once, globally and per session. */
export const CAPTURE_OPEN_GLOBAL = 8;
export const CAPTURE_OPEN_SESSION = 2;
/** A capture id is opaque and fixed-width; anything else is refused. */
export const CAPTURE_ID_MAX = 64;

// ---------------------------------------------------------------------------
// Outbound connections (host → direct client, host → one paired device)
// ---------------------------------------------------------------------------

/** Queued + in-flight bytes for one direct socket before diagnostics are shed. */
export const CLIENT_QUEUE_SOFT_BYTES = 4 * 1024 * 1024;
/** …and before the connection is fenced and closed. */
export const CLIENT_QUEUE_HARD_BYTES = 16 * 1024 * 1024;
/** Sitting above the soft mark this long is a peer that is not draining. */
export const CLIENT_STUCK_MS = 10_000;

/** The same two marks for one paired device's relay channel. */
export const RELAY_QUEUE_SOFT_BYTES = 1024 * 1024;
export const RELAY_QUEUE_HARD_BYTES = 4 * 1024 * 1024;

/** Per-connection shed counters are bounded: methods are few and named. */
export const SHED_COUNTER_METHODS_MAX = 16;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Coalesced transcript deltas waiting for a frame, before an immediate flush. */
export const PENDING_UPDATE_FLUSH_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// What may be shed
// ---------------------------------------------------------------------------

export type NotificationPressureClass = "state" | "diagnostic";

/**
 * May this notification be dropped when a connection is behind?
 *
 * Compiler-complete over `HostNotifications` on purpose, exactly like
 * `NOTIFICATION_SCOPE`: a new notification must decide whether losing it is
 * recoverable, and the answer is `"diagnostic"` only when a client can read the
 * same truth back with a request it already makes.
 */
export const NOTIFICATION_PRESSURE = {
  // Re-readable: `pi/logs/query` returns the same rows.
  "pi/logs/append": "diagnostic",
  // Re-readable: the packages list carries the terminal state.
  "pi/packages/progress": "diagnostic",
  // A nudge to re-measure; the next poll asks again.
  "resource/refresh_request": "diagnostic",
  // Re-readable: `resource/snapshot` carries the same pressure summary, so a
  // connection that is behind may lose this one rather than grow (RP-8).
  "resource/pressure": "diagnostic",

  // State, attention, questions, work. Never dropped.
  "session/update": "state",
  "pi/ui/request": "state",
  "pi/ui/event": "state",
  "pi/extension/message": "state",
  "pi/worker/status": "state",
  "pi/session/attention": "state",
  "pi/session/seen": "state",
  "pi/project/updated": "state",
  "pi/project/trust_request": "state",
  "pi/project/trust_resolved": "state",
  "pi/project/env/changed": "state",
  "pi/providers/login/event": "state",
  "pi/prefs/updated": "state",
  "pi/resource/process": "state",
  // Worker → host, never broadcast: losing it would lose the only record of
  // what a worker released, which nothing else can re-read (RP-8).
  "pi/resource/pressure": "state",
  "agents/updated": "state",
  "agents/run": "state",
  "agents/event": "state",
  // Seeded profiles a person is asked to review. State: nothing re-reads it.
  "models/profiles/seeded": "state",
  "mcp/changed": "state",
  "tasks/update": "state",
} satisfies Record<keyof HostNotifications, NotificationPressureClass>;

/** True only for the notifications a client can read back explicitly. */
export function isSheddable(method: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(NOTIFICATION_PRESSURE, method) &&
    (NOTIFICATION_PRESSURE as Record<string, NotificationPressureClass>)[method] === "diagnostic"
  );
}

/**
 * What the capture producer is allowed to know about its link (RP-7).
 *
 * Two facts, both about diagnostics and neither about work: how far behind the
 * link to the app is right now, and whether this installation keeps request
 * bodies at all. A capture answers to them; a command, a turn or a question
 * never does.
 */
export interface ProviderCaptureLink {
  /** Bytes accepted for the app and not yet written. Raw: never net of anyone. */
  pendingBytes: () => number;
  /** False when the store keeps summaries only, so no body is worth sending. */
  retainBodies: () => boolean;
  /**
   * Ask to hold `bytes` of capture in this process while it is sent.
   *
   * One authority for the whole worker, not one per session: without it, ten
   * sessions capturing at once each hold their own copy of a body, and the
   * host's own bounds say nothing about that. `undefined` means there is no
   * room, and the capture is recorded without its body rather than waiting.
   * The handle is released on every outcome.
   */
  reserve?: (bytes: number) => CaptureReservation | undefined;
  /**
   * Give the link a turn to write what it is holding.
   *
   * A large capture is sent as bounded pieces, and the loop that sends them
   * must let the pipe drain between pieces or it would put the whole capture
   * behind the session's own updates in one go. Awaited only when the backlog
   * is at its mark, so an idle link costs nothing.
   */
  drain?: () => Promise<void>;
  /** Test seam for the stall deadline; defaults to the wall clock. */
  now?: () => number;
}

/** A hold on this process's capture memory. Released exactly once. */
export interface CaptureReservation {
  release: () => void;
}

/**
 * How long a capture will wait for a link that is over its mark before giving
 * up on it.
 *
 * Counting turns of the event loop was the wrong question: a healthy link can
 * sit above the mark for many turns while the app is doing bounded work for
 * the pieces it has already taken — writing them to disk, for one — and a
 * capture that gave up on that was calling a working link stalled. What
 * matters is whether the backlog is still above the mark *after a real while*.
 * Five seconds is far longer than any bounded per-chunk work and far shorter
 * than a person would wait for anything.
 *
 * The bound is on time, never on bytes: while it waits, the link is holding
 * the mark plus the piece in flight, and nothing more.
 */
export const CAPTURE_STALL_DEADLINE_MS = 5_000;

/**
 * How long a response row waits for the request it answers to finish crossing.
 * Longer than the stall deadline by construction: a response must never
 * overtake a capture that is still within its own allowance.
 */
export const CAPTURE_RESPONSE_WAIT_MS = CAPTURE_STALL_DEADLINE_MS + 2_000;

/** What one connection released, in numbers. Never a payload, never a path. */
export interface ShedCounters {
  total: number;
  byMethod: Record<string, number>;
}
