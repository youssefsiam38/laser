import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseToolError, toolContract } from "@lasercode/protocol";
import { createLaserExtension } from "../src/index.js";
import { laserToolRegistry } from "../src/register-tool.js";

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
  // D-350: `web_search` is Laser's own tool, not the engine's — the person's
  // provider answers it — so it is under the contract, and it is the one tool
  // that leaves this machine.
  it("is registered under the tool contract as a read-only, external tool", () => {
    harness(async () => "unused");
    const spec = laserToolRegistry().get("web_search")!;
    expect(toolContract(spec)).toEqual([]);
    expect(spec.annotations).toEqual({ readOnly: true, idempotent: true, destructive: false, external: true });
    expect(spec.label).toBe("injected");
  });

  it("reports a provider failure in the contract's error shape", async () => {
    const h = harness(async () => {
      throw new Error("The search provider did not answer.");
    });
    const failure = await h.tools[0]!.execute("call", { query: "docs" }).catch((error: unknown) => error);
    expect(parseToolError((failure as Error).message)).toEqual({
      code: "web_search_failed",
      message: "The search provider did not answer.",
      committed: false,
      next: expect.stringContaining("web_search"),
    });
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
    expect(h.send.mock.calls[0]![0]).toMatchObject({
      active: [],
      failed: [{
        module: "web-access",
        failure: {
          owner: { kind: "module", module: "web-access" },
          stage: "register",
          category: "registration_error",
          message: "Could not register this capability. Restart the project or update the app.",
        },
      }],
    });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("private failure");
  });
});
