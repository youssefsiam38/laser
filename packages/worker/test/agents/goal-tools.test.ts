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

/** Every user turn in a request, flattened, so a request can be found by what was said. */
const userTextOf = (request: { messages: Array<{ role: string; content: unknown }> }): string =>
  request.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: string })?.text ?? "").join(" ")
          : "",
    )
    .join(" ");

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
    //
    // Not "the last request". The goal's own turn may still be running, and the
    // engine's automatic continuation can land another goal-bearing request
    // after `clear()` returns — under full-suite load it reliably did, which is
    // what made this test flaky (M13-T34). Wait for the session to go idle, then
    // assert on the request that actually carries the words sent below.
    await vi.waitFor(() => expect(driver.state().isStreaming).toBe(false), { timeout: 20_000, interval: 25 });
    await driver.goalAction?.({ action: "clear" });
    await driver.prompt([{ type: "text", text: "And again." }]);
    const cleared = await vi.waitFor(
      () => {
        const at = stub.requests.findLastIndex((request) => userTextOf(request).includes("And again."));
        expect(at).toBeGreaterThan(-1);
        return at;
      },
      { timeout: 20_000, interval: 25 },
    );
    expect(goalToolsIn(cleared)).toEqual([]);
  }, 120_000);
});
