/**
 * The abort handler the driver binds for the engine's extensions (review
 * finding #12). Nothing awaits it, so a rejected `abort()` used to become an
 * unhandled rejection — which ends the worker process, and with it every
 * conversation in the project.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";

/** The private the driver binds as `abortHandler`. */
const abortFromEngine = (driver: StableSdkDriver, session: Partial<AgentSession>): void =>
  (driver as unknown as { abortFromEngine(session: AgentSession): void }).abortFromEngine(session as AgentSession);

describe("the engine's abort handler", () => {
  it("keeps a failed stop off the process, and says why in the log", async () => {
    const driver = new StableSdkDriver();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      abortFromEngine(driver, { abort: () => Promise.reject(new Error("the engine could not stop the turn")) });
      // A handler that throws synchronously is the same class of failure.
      abortFromEngine(driver, { abort: () => { throw new Error("the runtime was already gone"); } });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", listener);
    }

    expect(unhandled).toEqual([]);
    const text = logged.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(text).toContain("the engine could not stop the turn");
    expect(text).toContain("the runtime was already gone");
    logged.mockRestore();
  });
});
