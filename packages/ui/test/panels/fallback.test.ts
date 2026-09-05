import { describe, expect, it } from "vitest";
import type { SessionState } from "@lasercode/protocol";

import { dialogPanel, fallbackPanels, inlineContent, uiResponseFor, widgetPanel } from "../../src/panels/fallback.js";
import type { SessionView } from "../../src/store.js";

const state: SessionState = {
  path: "/s.jsonl",
  id: "s",
  cwd: "/p",
  model: null,
  thinkingLevel: "medium",
  isStreaming: true,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/s.jsonl",
  state,
  blocks: [{ kind: "tool", id: "t1", name: "bash", args: {}, done: false }],
  lastSeq: 0,
  running: true,
  queue: { steering: [], followUp: [] },
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  ...over,
});

describe("fallback", () => {
  it("a widget becomes a stream panel keyed by its widget key, with client-local content", () => {
    const v = view({ widgets: { sandbox: { lines: ["one", "twö"], placement: "aboveEditor" } } });
    const [panel] = fallbackPanels(v);
    expect(panel).toEqual(widgetPanel("sandbox", ["one", "twö"], true));
    expect(panel).toMatchObject({ kind: "stream", id: "ui:widget:sandbox", encoding: "text", ref: "inline:widget:sandbox", bytes: 8 });
    expect(inlineContent(v, "inline:widget:sandbox")).toBe("one\ntwö");
    expect(inlineContent(v, "file:/x")).toBeUndefined();
  });

  it("a dialog becomes a decision; one already in its tool row is left there", () => {
    const v = view({
      dialogs: [
        { method: "confirm", id: "u1", title: "Write it?", message: "This overwrites.", toolCallId: "t1" },
        { method: "select", id: "u2", title: "Pick", options: ["A", "B"], timeoutMs: 5000 },
        { method: "input", id: "u3", title: "Name?", placeholder: "type here", toolCallId: "gone" },
      ],
    });
    const panels = fallbackPanels(v);
    expect(panels.map((p) => p.id)).toEqual(["ui:dialog:u2", "ui:dialog:u3"]);
    expect(panels[0]).toMatchObject({ kind: "decision", blocking: "turn", timeoutMs: 5000, fields: [{ id: "choice", type: "choice", options: ["A", "B"] }] });
    expect(panels[1]).toMatchObject({ kind: "decision", blocking: "turn", fields: [{ id: "value", type: "text", label: "type here" }] });
  });

  it("confirm carries a rejection field, and answers map back to pi/ui/response", () => {
    const panel = dialogPanel({ method: "confirm", id: "u1", title: "Deploy?", message: "prod" }, false);
    expect(panel.rejection).toEqual({ label: "No", field: "feedback" });
    expect(panel.message).toBe("prod");
    expect(uiResponseFor("u1", "confirm", { confirmed: true })).toEqual({ id: "u1", confirmed: true });
    expect(uiResponseFor("u1", "confirm", { confirmed: false, feedback: "not today" })).toEqual({ id: "u1", confirmed: false });
    expect(uiResponseFor("u2", "select", { choice: "B" })).toEqual({ id: "u2", value: "B" });
    expect(uiResponseFor("u3", "editor", { value: "text" })).toEqual({ id: "u3", value: "text" });
    expect(uiResponseFor("u3", "input", undefined)).toEqual({ id: "u3", cancelled: true });
  });
});
