/**
 * Worker session lifetime (RP-4): the difference between a client letting go of
 * a conversation and a runtime being safe to release.
 *
 * Three states, never conflated:
 *
 * - **membership** — which connections and surfaces are following a session.
 *   Owned by the host (RP-6, `SessionMembershipView`), reference-counted by
 *   connection and scope, and read here only as "does anybody hold it".
 * - **runtime** — whether a worker currently has the session open. Released by
 *   {@link SessionPin}-free unload, restored by the next `session/load`.
 * - **durability** — the canonical Pi session record, which neither transition
 *   touches. Unload is not close, not delete and not move: nothing is written,
 *   nothing is cancelled and no file changes.
 *
 * A pin is the one vocabulary for "this runtime is holding something a release
 * would destroy". It is computed in the worker, because the worker is the only
 * party that can see a streaming turn, an unanswered question, a queued
 * message, a run or a running command — and it is computed once, by one
 * predicate, consumed both by unload and by automatic worker retirement, so
 * automatic retirement can never be less careful than unload (RP-4/RP-8).
 */
import { z } from "zod";

/**
 * Why a session's runtime may not be released right now.
 *
 * Every kind names something that lives only in the runtime, or work that is
 * in flight. None of them is a reason to *stop* anything: a pinned session is
 * refused, never cancelled, compacted or answered.
 */
export type SessionPinKind =
  /** A `session/load` for this path is still in flight in this worker. */
  | "opening"
  /** A request naming this session is being served right now. */
  | "in_flight_request"
  /** A turn is running (including a fallback switch between engine runs). */
  | "streaming"
  /** History compaction is running. */
  | "compacting"
  /** First-turn preflight holds this session, or a speculative runtime does. */
  | "first_turn"
  /** An extension question is waiting for a person. */
  | "question"
  /** A tool approval is waiting for a person. */
  | "approval"
  /** A non-terminal agent run executes in this session. */
  | "agent_run"
  /** A non-terminal agent run of a child needs this session's runtime to wake. */
  | "child_run"
  /** Steering/follow-up work is queued in the engine or in the harness. */
  | "queued_work"
  /** The person's pending tray holds messages; the tray is memory only. */
  | "pending_tray"
  /** A foreground or background command of this session is running. */
  | "task"
  /** A first prompt is still waiting for a model to name its session. */
  | "naming"
  /** Tool labels are being produced for calls that are still running. */
  | "tool_labeling"
  /** There is no durable record to reopen from, so releasing would lose the session. */
  | "no_record";

export const SESSION_PIN_KINDS: readonly SessionPinKind[] = [
  "opening",
  "in_flight_request",
  "streaming",
  "compacting",
  "first_turn",
  "question",
  "approval",
  "agent_run",
  "child_run",
  "queued_work",
  "pending_tray",
  "task",
  "naming",
  "tool_labeling",
  "no_record",
] as const;

/**
 * Pins that describe work a person or an agent is in the middle of.
 *
 * Automatic release — the idle/over-cap unload sweep and automatic worker
 * retirement — refuses on **any** pin, so the two automatic paths are exactly
 * as careful as each other. A person's explicit "stop this worker" refuses on
 * these, the ones that would destroy work in flight; the three that are left
 * out (`naming`, `tool_labeling`, `no_record`) are moments, not work, and a
 * person who asked for a stop is not told to wait for a label.
 */
export const SESSION_WORK_PIN_KINDS: readonly SessionPinKind[] = [
  "opening",
  "in_flight_request",
  "streaming",
  "compacting",
  "first_turn",
  "question",
  "approval",
  "agent_run",
  "child_run",
  "queued_work",
  "pending_tray",
  "task",
] as const;

export function isSessionWorkPin(kind: SessionPinKind): boolean {
  return (SESSION_WORK_PIN_KINDS as readonly string[]).includes(kind);
}

/** One reason, with a bounded human detail. Never a path and never a payload. */
export interface SessionPin {
  kind: SessionPinKind;
  /** Short, sanitized, for a diagnostic line — never shown as an error to a person. */
  detail?: string;
}

/** What one loaded session is holding. Empty `pins` means it is safe to release. */
export interface SessionSafety {
  path: string;
  pins: SessionPin[];
}

/**
 * At most this many sessions are reported in one safety answer.
 *
 * Reaching it makes the answer **incomplete**, and an incomplete answer is not
 * a safe one: the session that was cut could be the one holding a question.
 */
export const SESSION_SAFETY_MAX = 512;
/** Bound for a pin's detail text. */
export const SESSION_PIN_DETAIL_MAX = 120;

/** Why the host asked for a release. Diagnostic only; the answer never depends on it. */
export type SessionUnloadReason = "idle" | "budget" | "pressure";

export const sessionPinSchema = z
  .object({
    kind: z.enum(SESSION_PIN_KINDS as unknown as [SessionPinKind, ...SessionPinKind[]]),
    detail: z.string().min(1).max(SESSION_PIN_DETAIL_MAX).optional(),
  })
  .strict();

export const sessionLifetimeParamsSchemas = {
  "pi/session/unload": z
    .object({
      path: z.string().min(1).max(4096),
      reason: z.enum(["idle", "budget", "pressure"]).optional(),
    })
    .strict(),
  "pi/worker/safety": z.object({}).strict(),
};

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * Host → an already-live worker: release this session's runtime if, and
     * only if, nothing is pinning it.
     *
     * Never a client's call, and deliberately not `pi/session/close`: close is
     * the file-move fence and refuses only a streaming turn. This refuses
     * everything a release would destroy and answers with the reasons.
     * `unloaded: false` with no pins means the worker does not hold that
     * session, which is not an error.
     */
    "pi/session/unload": {
      params: { path: string; reason?: SessionUnloadReason };
      result: { unloaded: boolean; pins: SessionPin[] };
    };
    /**
     * Host → an already-live worker: what each of its loaded sessions is
     * holding, from the same predicate `pi/session/unload` applies.
     *
     * Read-only, and the reason automatic retirement cannot be less careful
     * than unload: the pool asks this before it retires a worker nobody is
     * following, rather than deciding from its own coarser bookkeeping.
     */
    "pi/worker/safety": {
      params: {};
      result: {
        /**
         * Every session this worker holds **and every one it is opening or
         * releasing**, so a load in flight is visible as work rather than as
         * an absence.
         */
        sessions: SessionSafety[];
        /**
         * Whether that list is the whole truth. False when it hit
         * {@link SESSION_SAFETY_MAX}. A caller must treat an incomplete answer
         * exactly as it treats no answer at all: the worker keeps working.
         */
        complete: boolean;
      };
    };
  }
}
