import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLaserExtension } from "../src/index.js";

function harness(search?: (query: string, signal?: AbortSignal, options?: object) => Promise<string>, fail = false) {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const send = vi.fn();
  const pi = {
    on: (name: string, callback: (...args: unknown[]) => unknown) => events.set(name, callback),
    registerTool: (tool: typeof tools[number]) => { if (fail) throw new Error("private failure"); tools.push(tool); },
  } as unknown as ExtensionAPI;
  const extension = createLaserExtension({ send, only: ["web-access"], ...(search ? { webSearch: search } : {}) });
  if (typeof extension === "function") extension(pi); else extension.factory(pi);
  return { events, tools, send };
}

describe("web access companion module", () => {
  it("registers before session start and forwards only the query options and abort signal", async () => {
    const search = vi.fn().mockResolvedValue("source result");
    const h = harness(search);
    expect(h.tools.map((tool) => tool.name)).toEqual(["web_search"]);
    const signal = new AbortController().signal;
    expect(await h.tools[0]!.execute("call", { query: "docs", numResults: 3 }, signal)).toEqual({ content: [{ type: "text", text: "source result" }], details: {} });
    expect(search).toHaveBeenCalledWith("docs", signal, { numResults: 3 });
    await h.events.get("session_start")!({}, {});
    expect(h.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: ["web-access"], failed: [] });
    expect(h.send).toHaveBeenCalledOnce(); // no duplicate results panel
  });
  it("has no tool or capability without an enabled search executor", async () => {
    const h = harness();
    expect(h.tools).toEqual([]);
    await h.events.get("session_start")!({}, {});
    expect(h.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: [], failed: [] });
  });
  it("reports a registration failure without failing the session or exposing its raw error", async () => {
    const h = harness(async () => "unused", true);
    await h.events.get("session_start")!({}, {});
    expect(h.send.mock.calls[0]![0]).toMatchObject({ active: [], failed: [{ module: "web-access" }] });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("private failure");
  });
});
