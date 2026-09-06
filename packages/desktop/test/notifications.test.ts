import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Notification: class {
    static isSupported(): boolean {
      return true;
    }
  },
}));

import { notificationCopy } from "../src/notifications.js";
import type { AttentionChange } from "../src/fleet.js";

function change(name: string | undefined, to: AttentionChange["to"]): AttentionChange {
  return {
    session: {
      path: "/sessions/a.jsonl",
      cwd: "/workspace/laser",
      name,
      attention: to,
      modifiedAt: "2026-09-06T10:00:00.000Z",
    },
    from: "working",
    to,
    initial: false,
  };
}

describe("native notification copy", () => {
  it("uses the fleet's resolved session title", () => {
    expect(notificationCopy(change("Fix the native notification title", "finished_unread"))).toEqual({
      title: "laser finished",
      body: "Fix the native notification title is done. Nothing is running there now.",
    });
  });

  it("never invents an Untitled session label when no title exists", () => {
    const copy = notificationCopy(change(undefined, "finished_unread"));
    expect(copy?.body).toBe("The session is done. Nothing is running there now.");
    expect(JSON.stringify(copy)).not.toContain("Untitled");
  });
});
