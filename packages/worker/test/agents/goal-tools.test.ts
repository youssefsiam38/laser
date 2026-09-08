/**
 * D-146 · the goal engine's tools reach the model only while a goal is active.
 *
 * Against the real engine and a stub provider, because the question the gate
 * has to answer is one of ordering: a goal started this turn must have its
 * tools in that same request, and a cleared goal must have lost them by the
 * next one. Reading the tool list of the request the provider actually
 * received is the only honest way to know.
 */
import { GOAL_TOOL_NAMES } from "@lasercode/pi-goal";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { startStubProvider, toolNamesOf, writeStubModels, type StubProvider } from "./stub-provider.js";

let base: string;
let stub: StubProvider;
let driver: StableSdkDriver;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-goal-tools-`));
  for (const name of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, name), { recursive: true });
  // Plain text every time: what is asserted is the request, not the reply.
  stub = await startStubProvider(() => ({ text: "Noted." }));
  writeStubModels(join(base, "agent"), stub.url);
  driver = new StableSdkDriver();
});

afterEach(async () => {
  await driver.dispose().catch(() => undefined);
  await stub.close();
  rmSync(base, { recursive: true, force: true });
});

const open = () =>
  driver.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: ["goals"],
  });

const goalToolsIn = (index: number): string[] => toolNamesOf(stub.requests[index]!).filter((name) => GOAL_TOOL_NAMES.includes(name));

describe("the goal engine's tools", () => {
  it("are absent from an ordinary session, present from the first goal turn, and gone once the goal is cleared", async () => {
    await open();
    await driver.setModel({ provider: "stub", id: "stub-1" });

    // 1 · No goal: the engine registered the tools at load, and the gate keeps
    // them out of the request, so nothing argues to the model that a goal exists.
    await driver.prompt([{ type: "text", text: "Say hello." }]);
    expect(stub.requests).toHaveLength(1);
    expect(goalToolsIn(0)).toEqual([]);

    // 2 · A goal starts. The gate runs before the turn's request is built, so
    // the very first goal turn can complete the goal it was given.
    const started = await driver.goalAction?.({ action: "start", objective: "Count the files here" });
    expect(started?.status).toBe("active");
    // The engine sends the goal's own prompt; wait for that turn's request.
    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThan(1), { timeout: 20_000, interval: 25 });
    expect(goalToolsIn(stub.requests.length - 1)).toEqual([...GOAL_TOOL_NAMES]);

    // 3 · Cleared: the next request carries none of them again.
    await driver.goalAction?.({ action: "clear" });
    const before = stub.requests.length;
    await driver.prompt([{ type: "text", text: "And again." }]);
    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThan(before), { timeout: 20_000, interval: 25 });
    expect(goalToolsIn(stub.requests.length - 1)).toEqual([]);
  }, 120_000);
});
