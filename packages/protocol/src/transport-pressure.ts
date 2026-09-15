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
 * - **Only three notifications may be shed**, and each is explicitly
 *   re-readable by a request the client already makes.
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
  "agents/updated": "state",
  "agents/run": "state",
  "agents/event": "state",
  "agents/beam/choose-model": "state",
  "mcp/changed": "state",
  "tasks/update": "state",
} satisfies Record<keyof HostNotifications, NotificationPressureClass>;

/** True only for the three notifications a client can read back explicitly. */
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
  /** Bytes accepted for the app and not yet written. */
  pendingBytes: () => number;
  /** False when the store keeps summaries only, so no body is worth sending. */
  retainBodies: () => boolean;
}

/** What one connection released, in numbers. Never a payload, never a path. */
export interface ShedCounters {
  total: number;
  byMethod: Record<string, number>;
}
