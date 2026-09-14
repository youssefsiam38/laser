/**
 * The engine load cache (review finding #38): one success per worker process,
 * but a failure is never remembered — a transient fault must not take MCP
 * away from every conversation in the project until the app is restarted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpEngine, setMcpEngineLoaderForTests, type McpEngine } from "../../src/mcp/engine.js";

const engine = (tag: string): McpEngine => ({ statusEvent: tag } as unknown as McpEngine);

afterEach(() => {
  setMcpEngineLoaderForTests();
});

describe("loadMcpEngine", () => {
  it("retries after a rejected load instead of caching the failure", async () => {
    let attempts = 0;
    setMcpEngineLoaderForTests(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("the transpiler could not read its cache");
      return engine("second");
    });

    await expect(loadMcpEngine()).rejects.toThrow("the transpiler could not read its cache");
    await expect(loadMcpEngine()).resolves.toBe(await loadMcpEngine());
    expect((await loadMcpEngine()).statusEvent).toBe("second");
    expect(attempts).toBe(2);
  });

  it("loads once for concurrent callers and once for every later one", async () => {
    let attempts = 0;
    setMcpEngineLoaderForTests(async () => {
      attempts += 1;
      return engine(`load-${attempts}`);
    });

    const [first, second] = await Promise.all([loadMcpEngine(), loadMcpEngine()]);
    expect(first).toBe(second);
    expect(await loadMcpEngine()).toBe(first);
    expect(attempts).toBe(1);
  });
});
