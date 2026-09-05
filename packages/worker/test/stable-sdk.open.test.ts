/**
 * M0-T4 integration: the real driver opens a Pi session on the pinned SDK.
 * Everything is sandboxed in a temp dir (agentDir, sessionDir, cwd) so the
 * user's real ~/.pi/agent is never read or written.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../src/driver.js";

let base: string;
let driver: StableSdkDriver;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-sdk-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent"), { recursive: true });
  driver = new StableSdkDriver();
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  rmSync(base, { recursive: true, force: true });
});

describe("StableSdkDriver.open", () => {
  it("opens a session in a sandboxed agent dir and reports state", async () => {
    const events: DriverEvent[] = [];
    driver.subscribe((e) => events.push(e));

    const state = await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });

    expect(state.cwd).toBe(join(base, "project"));
    expect(state.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.isStreaming).toBe(false);
    expect(state.messageCount).toBe(0);
    expect(state.path).toContain(join(base, "sessions"));

    // The companion extension ran its detection pass and reported.
    const caps = events.find((e) => e.type === "extension" && e.message.type === "piorbit/capabilities");
    expect(caps).toBeDefined();
    if (caps?.type === "extension" && caps.message.type === "piorbit/capabilities") {
      expect(caps.message.active).toContain("provider-log");
      expect(caps.message.failed).toEqual([]);
    }

    // Pi creates the session file lazily on the first persisted entry, so at
    // open time only the path is decided. It must point inside the sandbox and
    // the real ~/.pi/agent must not have been touched.
    expect(state.path.startsWith(join(base, "sessions"))).toBe(true);
    expect(existsSync(join(base, "agent", "sessions"))).toBe(false);
  }, 60_000);

  it("refuses a second open and fails closed before open", async () => {
    await expect(driver.listModels()).rejects.toThrow(/no open session/);
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    await expect(
      driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") }),
    ).rejects.toThrow(/already open/);
  }, 60_000);

  it("lists models from the pinned Pi catalog", async () => {
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    const models = await driver.listModels();
    expect(models.length).toBeGreaterThan(10);
    expect(models[0]).toMatchObject({ provider: expect.any(String), id: expect.any(String) });
  }, 60_000);
});
