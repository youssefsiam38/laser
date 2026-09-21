/**
 * M21-T9: what the sender is told about the work its message mentioned.
 *
 * The message always goes. What comes back is the host's answer about each
 * mention: sent as pinned, re-pinned to what this computer holds, or
 * unavailable with the reason — and only the last two are worth a person's
 * attention, in the host's own words.
 */
import { describe, expect, it } from "vitest";
import type { ProjectWorkMentionOutcome, ProjectWorkRef } from "@lasercode/protocol";

import { sendToSession, type RequestClient } from "../../src/runtime/adapter.js";
import type { Action } from "../../src/store.js";

const ref: ProjectWorkRef = {
  projectId: "p1",
  kind: "task",
  entityId: "e44",
  revisionId: "r3",
  digest: "a".repeat(64),
  key: "TASK-44",
  label: "Rework the picker",
};

function clientAnswering(projectWork: ProjectWorkMentionOutcome[]): { client: RequestClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const client: RequestClient = {
    request: (async (method: string, params: unknown) => {
      sent.push({ method, params });
      return { accepted: true, queued: false, projectWork };
    }) as RequestClient["request"],
  };
  return { client, sent };
}

describe("sending a message that mentions project work", () => {
  it("says nothing when every mention was read exactly as it was pinned", async () => {
    const { client } = clientAnswering([{ ref, status: "sent" }]);
    const actions: Action[] = [];
    await sendToSession(client, "/s.jsonl", [{ type: "text", text: "do @TASK-44" }], "prompt", (action) => actions.push(action));
    expect(actions.filter((action) => action.type === "toast")).toHaveLength(0);
  });

  it("says once, in the host's words, what it re-pinned and what it could not read", async () => {
    const { client } = clientAnswering([
      { ref, status: "repinned", note: "TASK-44 was re-read from this computer's copy, which differs from the one this message pinned." },
      { ref: { ...ref, key: "SPEC-3", kind: "spec" }, status: "unavailable", note: "SPEC-3 is in a project this app does not have here, so its content was not sent." },
    ]);
    const actions: Action[] = [];
    await sendToSession(client, "/s.jsonl", [{ type: "text", text: "do @TASK-44 and @SPEC-3" }], "prompt", (action) => actions.push(action));

    const toasts = actions.filter((action): action is Extract<Action, { type: "toast" }> => action.type === "toast");
    expect(toasts.map((toast) => toast.level)).toEqual(["info", "warning"]);
    expect(toasts[0]!.text).toContain("TASK-44");
    expect(toasts[1]!.text).toContain("SPEC-3");
  });

  it("still delivers the message, whatever became of the mentions", async () => {
    const { client, sent } = clientAnswering([{ ref, status: "unavailable", note: "gone" }]);
    const behavior = await sendToSession(client, "/s.jsonl", [{ type: "text", text: "do @TASK-44" }], "prompt", () => {});
    expect(behavior).toBe("prompt");
    expect(sent).toHaveLength(1);
  });
});
