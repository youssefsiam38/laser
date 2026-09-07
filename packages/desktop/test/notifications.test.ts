import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";

const { instances } = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("electron", () => ({
  Notification: class {
    listeners = new Map<string, () => void>();
    constructor() { instances.push(this); }
    on(name: string, listener: () => void) { this.listeners.set(name, listener); }
    show = vi.fn();
    close = vi.fn(() => this.listeners.get("close")?.());
    static isSupported(): boolean {
      return true;
    }
  },
}));

import { notificationCopy, Notifier } from "../src/notifications.js";
import type { DesktopLog } from "../src/log.js";
import type { AttentionChange } from "../src/fleet.js";

function change(name: string | undefined, to: AttentionChange["to"]): AttentionChange {
  return {
    session: {
      path: "/sessions/a.jsonl",
      cwd: `/workspace/${PRODUCT_NAME}`,
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
      title: `${PRODUCT_NAME} finished`,
      body: "Fix the native notification title is done. Nothing is running there now.",
    });
  });

  it("never invents an Untitled session label when no title exists", () => {
    const copy = notificationCopy(change(undefined, "finished_unread"));
    expect(copy?.body).toBe("The session is done. Nothing is running there now.");
    expect(JSON.stringify(copy)).not.toContain("Untitled");
  });
});

describe("native notification lifecycle", () => {
  beforeEach(() => { instances.length = 0; });
  const make = (foreground = () => false) => new Notifier({
    log: { line: vi.fn(), error: vi.fn() } as unknown as DesktopLog,
    isForeground: foreground, onActivate: vi.fn(),
  });
  it("withdraws only the viewed session and preserves its repeat throttle", () => {
    const notifier = make();
    const a = change("A", "finished_unread"), b = change("B", "waiting_for_input");
    b.session.path = "/sessions/b.jsonl";
    notifier.handle(a, 100_000); notifier.handle(b, 100_001);
    notifier.clear(a.session.path);
    expect(instances[0].close).toHaveBeenCalledTimes(1);
    expect(instances[1].close).not.toHaveBeenCalled();
    expect(notifier.handle(a, 100_002)).toBe(false);
    notifier.clear(a.session.path);
    expect(instances[0].close).toHaveBeenCalledTimes(1);
  });
  it("clears resolved reminders even while foreground suppression applies", () => {
    let foreground = false;
    const notifier = make(() => foreground);
    notifier.handle(change("A", "error"), 100_000);
    foreground = true;
    notifier.handle(change("A", "idle"), 100_001);
    expect(instances[0].close).toHaveBeenCalledOnce();
  });
  it("withdraws native delivery that completes after acknowledgement", () => {
    const notifier = make();
    notifier.handle(change("A", "finished_unread"), 100_000);
    notifier.clear("/sessions/a.jsonl");
    instances[0].listeners.get("show")?.();
    expect(instances[0].close).toHaveBeenCalledTimes(2);
  });
  it("replaces a superseded reminder; a late old close cannot discard the new one", () => {
    const notifier = make();
    notifier.handle(change("A", "finished_unread"), 100_000);
    notifier.handle(change("A", "error"), 140_000);
    expect(instances[0].close).toHaveBeenCalledOnce();
    instances[0].listeners.get("close")?.();
    notifier.clear("/sessions/a.jsonl");
    expect(instances[1].close).toHaveBeenCalledOnce();
  });
  it("handles manual dismissal and close failures without crashing", () => {
    const notifier = make();
    notifier.handle(change("A", "error"), 100_000);
    instances[0].close.mockImplementation(() => { throw new Error("server gone"); });
    expect(() => notifier.clear("/sessions/a.jsonl")).not.toThrow();
    notifier.handle(change("A", "error"), 140_000);
    instances[1].listeners.get("close")?.();
    expect(() => notifier.clear("/sessions/a.jsonl")).not.toThrow();
  });
});
