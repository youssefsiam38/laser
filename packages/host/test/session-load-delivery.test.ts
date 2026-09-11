import { describe, expect, it } from "vitest";
import type { JsonRpcNotification } from "@lasercode/protocol";
import { SessionLoadDelivery } from "../src/session-load-delivery.js";

const question = (path: string, id: string): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method: "pi/ui/request",
  params: { path, id, method: "confirm", title: "Continue?" },
});
const close = (path: string, id: string): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method: "pi/ui/event",
  params: { path, method: "dialogResolved", id },
});

describe("SessionLoadDelivery", () => {
  it("holds questions only and records both close orderings without holding closes", async () => {
    const delivery = new SessionLoadDelivery("/s/a");
    expect(delivery.offer({ jsonrpc: "2.0", method: "session/update", params: {} })).toBe(false);
    expect(delivery.offer(question("/s/a", "request-close"))).toBe(true);
    expect(delivery.offer(close("/s/a", "request-close"))).toBe(false);
    expect(delivery.offer(close("/s/a", "close-request"))).toBe(false);
    expect(delivery.offer(question("/s/a", "close-request"))).toBe(true);
    expect(delivery.offer(question("/s/other", "other"))).toBe(false);

    const sent: JsonRpcNotification[] = [];
    await expect(delivery.flush(async (notification) => { sent.push(notification); return true; })).resolves.toBe(true);
    expect(sent).toEqual([]);
  });

  it("lets a close invalidate every concurrent same-path load", async () => {
    const first = new SessionLoadDelivery("/s/a");
    const slow = new SessionLoadDelivery("/s/a");
    for (const delivery of [first, slow]) expect(delivery.offer(question("/s/a", "q"))).toBe(true);

    const firstSent: string[] = [];
    await first.flush(async (notification) => { firstSent.push((notification.params as { id: string }).id); return true; });
    expect(firstSent).toEqual(["q"]);

    expect(slow.offer(close("/s/a", "q"))).toBe(false);
    const slowSent: string[] = [];
    await slow.flush(async (notification) => { slowSent.push((notification.params as { id: string }).id); return true; });
    expect(slowSent).toEqual([]);
  });

  it("stops and disposes when the connection cannot take a replay", async () => {
    const delivery = new SessionLoadDelivery("/s/a");
    delivery.offer(question("/s/a", "one"));
    delivery.offer(question("/s/a", "two"));
    const sent: string[] = [];
    await expect(delivery.flush(async (notification) => {
      sent.push((notification.params as { id: string }).id);
      return false;
    })).resolves.toBe(false);
    expect(sent).toEqual(["one"]);
    expect(delivery.offer(question("/s/a", "late"))).toBe(false);
  });
});
