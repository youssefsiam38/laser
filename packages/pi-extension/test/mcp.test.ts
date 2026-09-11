/**
 * M14-T2 · the `mcp` companion module: it activates only when the worker
 * loaded the MCP engine for this session, listens on the channel the worker
 * gave it, and translates the engine's per-server states into the words
 * docs/mcp.md settled on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpRuntimeSnapshot } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { createLaserExtension } from "../src/index.js";
import { toRuntimeSnapshot } from "../src/modules/mcp.js";

const CHANNEL = "engine/status/v1";

function harness(mcp?: { statusEvent: string }) {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const channels = new Map<string, Array<(data: unknown) => void>>();
  let unsubscribed = 0;
  const send = vi.fn();
  const pi = {
    on: (name: string, callback: (...args: unknown[]) => unknown) => events.set(name, callback),
    registerTool: () => {},
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of channels.get(channel) ?? []) listener(data);
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        channels.set(channel, [...(channels.get(channel) ?? []), listener]);
        return () => {
          unsubscribed += 1;
          channels.set(channel, (channels.get(channel) ?? []).filter((entry) => entry !== listener));
        };
      },
    },
  } as unknown as ExtensionAPI;
  const extension = createLaserExtension({ send, only: ["mcp"], ...(mcp ? { mcp } : {}) });
  if (typeof extension === "function") extension(pi); else extension.factory(pi);
  return { events, pi, send, channels, unsubscribed: () => unsubscribed };
}

const engineSnapshot = {
  version: 1,
  servers: [
    { name: "playwright", status: "connected", listenState: "legacy", toolCount: 24, directToolCount: 24, resourceCount: 0, disabled: false },
    { name: "warm", status: "cached", listenState: "not-listening", toolCount: 3, directToolCount: 0, disabled: false },
    { name: "sleeping", status: "not-connected", listenState: "disconnected", toolCount: 0, directToolCount: 0, disabled: false },
    { name: "broken", status: "failed", listenState: "disconnected", toolCount: 0, directToolCount: 0, failedAgoSeconds: 12, disabled: false },
    { name: "locked", status: "needs-auth", listenState: "disconnected", toolCount: 0, directToolCount: 0, disabled: false },
    { name: "off", status: "disabled", listenState: "disconnected", toolCount: 0, directToolCount: 0, disabled: true },
  ],
  totalTools: 27,
  totalResources: 0,
  connectedCount: 1,
  disabledCount: 1,
};

describe("mcp companion module", () => {
  it("does not activate when this session has no MCP engine", async () => {
    const h = harness();
    await h.events.get("session_start")!({}, {});
    expect(h.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: [], failed: [] });
    h.pi.events.emit(CHANNEL, engineSnapshot);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("subscribes to the channel the worker gave it and reports every status in the product's words", async () => {
    const h = harness({ statusEvent: CHANNEL });
    await h.events.get("session_start")!({}, {});
    expect(h.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: ["mcp"], failed: [] });

    h.pi.events.emit(CHANNEL, engineSnapshot);
    const message = h.send.mock.calls.map(([value]) => value).find((value) => (value as { type: string }).type === "lasercode/mcp/status") as { snapshot: McpRuntimeSnapshot };
    expect(message.snapshot.servers).toEqual([
      { name: "playwright", status: "connected", toolCount: 24, directToolCount: 24, resourceCount: 0 },
      { name: "warm", status: "ready", toolCount: 3, directToolCount: 0 },
      { name: "sleeping", status: "unknown", toolCount: 0, directToolCount: 0 },
      { name: "broken", status: "failed", toolCount: 0, directToolCount: 0, failedAgoSeconds: 12 },
      { name: "locked", status: "needs-auth", toolCount: 0, directToolCount: 0 },
      { name: "off", status: "off", toolCount: 0, directToolCount: 0 },
    ]);
    expect(message.snapshot.totalTools).toBe(27);
    expect(message.snapshot.connectedCount).toBe(1);
  });

  it("forwards the empty snapshot a shutdown publishes, and stops listening after it", async () => {
    const h = harness({ statusEvent: CHANNEL });
    await h.events.get("session_start")!({}, {});
    h.pi.events.emit(CHANNEL, { version: 1, servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 });
    const statuses = h.send.mock.calls.map(([value]) => value).filter((value) => (value as { type: string }).type === "lasercode/mcp/status");
    expect(statuses).toHaveLength(1);
    expect((statuses[0] as { snapshot: McpRuntimeSnapshot }).snapshot.servers).toEqual([]);

    await h.events.get("session_shutdown")!({}, {});
    expect(h.unsubscribed()).toBe(1);
    h.pi.events.emit(CHANNEL, engineSnapshot);
    expect(h.send.mock.calls.filter(([value]) => (value as { type: string }).type === "lasercode/mcp/status")).toHaveLength(1);
  });

  it("ignores anything that is not a snapshot, and an unknown state is unknown", () => {
    expect(toRuntimeSnapshot(undefined)).toBeUndefined();
    expect(toRuntimeSnapshot({ servers: "no" })).toBeUndefined();
    const snapshot = toRuntimeSnapshot({ servers: [{ name: "odd", status: "something-new" }, { status: "connected" }] });
    expect(snapshot?.servers).toEqual([{ name: "odd", status: "unknown", toolCount: 0, directToolCount: 0 }]);
    expect(snapshot?.totalTools).toBe(0);
    expect(snapshot?.connectedCount).toBe(0);
  });
});
