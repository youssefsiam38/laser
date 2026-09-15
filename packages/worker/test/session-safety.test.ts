/**
 * RP-4 · the one safety predicate, on its own.
 *
 * `sessionPins` is what both `pi/session/unload` and `pi/worker/safety` answer
 * from, so this pins its vocabulary, its order and — the point of the whole
 * slice — that every in-memory source of work produces a pin.
 */
import { describe, expect, it } from "vitest";
import { SESSION_PIN_KINDS, SESSION_WORK_PIN_KINDS, isSessionWorkPin, type SessionPinKind } from "@lasercode/protocol";
import { sessionPins, type SessionSafetySnapshot } from "../src/session-safety.js";

const CLEAR: SessionSafetySnapshot = {
  opening: false,
  inFlightRequests: 0,
  streaming: false,
  compacting: false,
  firstTurn: false,
  questions: 0,
  approvals: 0,
  liveRuns: 0,
  liveChildRuns: 0,
  queuedWork: 0,
  trayMessages: 0,
  runningTasks: 0,
  naming: false,
  runningTools: 0,
  hasRecord: true,
};

/** Every source of work, with the one snapshot field that produces it. */
const SOURCES: Array<[SessionPinKind, Partial<SessionSafetySnapshot>]> = [
  ["opening", { opening: true }],
  ["in_flight_request", { inFlightRequests: 2 }],
  ["streaming", { streaming: true }],
  ["compacting", { compacting: true }],
  ["first_turn", { firstTurn: true }],
  ["question", { questions: 1 }],
  ["approval", { approvals: 3 }],
  ["agent_run", { liveRuns: 1 }],
  ["child_run", { liveChildRuns: 2 }],
  ["queued_work", { queuedWork: 4 }],
  ["pending_tray", { trayMessages: 1 }],
  ["task", { runningTasks: 1 }],
  ["naming", { naming: true }],
  ["tool_labeling", { runningTools: 2 }],
  ["no_record", { hasRecord: false }],
  ["close_failed", { closeFailed: true }],
];

describe("sessionPins", () => {
  it("says nothing is holding an idle session with a durable record", () => {
    expect(sessionPins(CLEAR)).toEqual([]);
  });

  it("produces exactly one pin for each in-memory source of work", () => {
    for (const [kind, patch] of SOURCES) {
      const pins = sessionPins({ ...CLEAR, ...patch });
      expect(pins.map((p) => p.kind), `${kind} snapshot`).toEqual([kind]);
    }
  });

  it("covers every declared kind, so a new source cannot be added without a pin", () => {
    expect(SOURCES.map(([kind]) => kind).sort()).toEqual([...SESSION_PIN_KINDS].sort());
  });

  it("reports every pin at once, in declaration order", () => {
    const all = SOURCES.reduce<SessionSafetySnapshot>((snapshot, [, patch]) => ({ ...snapshot, ...patch }), CLEAR);
    expect(sessionPins(all).map((pin) => pin.kind)).toEqual([...SESSION_PIN_KINDS]);
  });

  it("gives a person-readable count in the detail without leaking a path", () => {
    const pins = sessionPins({ ...CLEAR, approvals: 2, runningTasks: 1 });
    expect(pins).toEqual([
      { kind: "approval", detail: "2 approval(s) waiting" },
      { kind: "task", detail: "1 command(s) running" },
    ]);
  });

  it("classifies work pins, which is what an explicit stop refuses on", () => {
    for (const kind of SESSION_WORK_PIN_KINDS) expect(isSessionWorkPin(kind), kind).toBe(true);
    for (const kind of ["naming", "tool_labeling", "no_record"] as const) expect(isSessionWorkPin(kind), kind).toBe(false);
    // A runtime that could not be closed is still serving the conversation, so
    // an explicit stop refuses on it too.
    expect(isSessionWorkPin("close_failed")).toBe(true);
    // Automatic release refuses on *any* pin, so the work set is a subset and
    // never the whole vocabulary: the two lists must not drift into one. The
    // advisory set is exactly the three named above, and this pins the count so
    // a new kind cannot quietly join them.
    expect(SESSION_WORK_PIN_KINDS.length).toBeLessThan(SESSION_PIN_KINDS.length);
    const advisory = SESSION_PIN_KINDS.filter((kind) => !isSessionWorkPin(kind));
    expect(advisory).toEqual(["naming", "tool_labeling", "no_record"]);
  });
});
