/**
 * M1-T10: which tool call a dialog belongs to.
 *
 * Pi hands extension dialogs no tool call id, so the worker attributes one only
 * under single-tool causality — exactly one tool call executing. The tracker
 * derives that set from the session event stream; the driver prefers Pi's own
 * `AgentState.pendingToolCalls` and falls back to the tracker, which is what
 * these tests exercise (no live Pi, no runtime).
 */
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { UiDialogRequest } from "@lasercode/protocol";
import { PendingToolCallTracker, StableSdkDriver } from "../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../src/driver.js";

const start = (toolCallId: string, toolName = "bash"): AgentSessionEvent =>
  ({ type: "tool_execution_start", toolCallId, toolName, args: {} }) as unknown as AgentSessionEvent;

const end = (toolCallId: string, toolName = "bash"): AgentSessionEvent =>
  ({ type: "tool_execution_end", toolCallId, toolName, result: "ok", isError: false }) as unknown as AgentSessionEvent;

const ended = { type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent;
const settled = { type: "agent_settled" } as AgentSessionEvent;

describe("PendingToolCallTracker", () => {
  it("reports an id only while exactly one tool call is executing", () => {
    const tracker = new PendingToolCallTracker();
    expect(tracker.single()).toBeUndefined();

    tracker.note(start("t1"));
    expect(tracker.single()).toBe("t1");

    // Parallel tools: no sound attribution, so the dialog is free-standing.
    tracker.note(start("t2"));
    expect(tracker.single()).toBeUndefined();
    expect(tracker.ids().size).toBe(2);

    tracker.note(end("t2"));
    expect(tracker.single()).toBe("t1");

    tracker.note(end("t1"));
    expect(tracker.single()).toBeUndefined();
    expect(tracker.ids().size).toBe(0);
  });

  it("ignores unrelated events and unknown end ids", () => {
    const tracker = new PendingToolCallTracker();
    tracker.note(start("t1"));
    tracker.note({ type: "text_delta" } as unknown as AgentSessionEvent);
    tracker.note({ type: "turn_end" } as unknown as AgentSessionEvent);
    tracker.note(end("never-started"));
    expect(tracker.single()).toBe("t1");

    // A repeated start is idempotent (a Set, not a counter).
    tracker.note(start("t1"));
    expect(tracker.single()).toBe("t1");
  });

  it("drops leaked ids when the run ends, matching Pi's finishRun()", () => {
    const tracker = new PendingToolCallTracker();
    tracker.note(start("t1"));
    tracker.note(start("t2"));
    // An abort can skip `tool_execution_end`; run over means nothing executes.
    tracker.note(ended);
    expect(tracker.ids().size).toBe(0);
    expect(tracker.single()).toBeUndefined();

    tracker.note(start("t3"));
    tracker.note(settled);
    expect(tracker.single()).toBeUndefined();

    tracker.note(start("t4"));
    tracker.clear();
    expect(tracker.single()).toBeUndefined();
  });
});

describe("StableSdkDriver dialog attribution", () => {
  /** Reach past `private` — the wiring under test is internal by design. */
  type Internals = {
    onSessionEvent(event: AgentSessionEvent): void;
    ui: { context: { confirm(title: string, message: string): Promise<boolean> } };
  };

  function driverHarness() {
    const driver = new StableSdkDriver();
    const requests: UiDialogRequest[] = [];
    driver.subscribe((e: DriverEvent) => {
      if (e.type === "ui_request") requests.push(e.request);
    });
    return { driver, requests, internals: driver as unknown as Internals };
  }

  it("stamps the toolCallId derived from the event stream", () => {
    const { requests, internals } = driverHarness();

    void internals.ui.context.confirm("Proceed?", "before any tool");
    expect(requests[0]).not.toHaveProperty("toolCallId");

    internals.onSessionEvent(start("call-a"));
    void internals.ui.context.confirm("Proceed?", "one tool running");
    expect(requests[1]).toMatchObject({ method: "confirm", toolCallId: "call-a" });

    internals.onSessionEvent(start("call-b"));
    void internals.ui.context.confirm("Proceed?", "two tools running");
    expect(requests[2]).not.toHaveProperty("toolCallId");

    internals.onSessionEvent(end("call-a"));
    void internals.ui.context.confirm("Proceed?", "one tool left");
    expect(requests[3]).toMatchObject({ method: "confirm", toolCallId: "call-b" });

    internals.onSessionEvent(end("call-b"));
    void internals.ui.context.confirm("Proceed?", "nothing running");
    expect(requests[4]).not.toHaveProperty("toolCallId");
  });

  it("emits dialogResolved for dialogs it tears down on dispose", async () => {
    const { driver, internals } = driverHarness();
    const events: DriverEvent[] = [];
    driver.subscribe((e) => events.push(e));

    internals.onSessionEvent(start("call-a"));
    const answer = internals.ui.context.confirm("Proceed?", "tool dialog");
    await driver.dispose();

    // Safe default, and the client is told the dialog is gone.
    await expect(answer).resolves.toBe(false);
    const resolvedIds = events
      .filter((e) => e.type === "ui_event" && e.event.method === "dialogResolved")
      .map((e) => (e as { event: { id: string } }).event.id);
    expect(resolvedIds).toHaveLength(1);
  });
});
