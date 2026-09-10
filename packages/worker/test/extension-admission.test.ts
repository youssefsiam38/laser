import { describe, expect, it, vi } from "vitest";
import type { ExtensionModelAdmission, ExtensionModelWorkRequest } from "../src/driver.js";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface FakeOptions {
  source?: "extension";
  streamingBehavior?: "steer" | "followUp";
  preflightResult?: (accepted: boolean) => void;
}

interface FakeSession {
  isStreaming: boolean;
  prompt(text: string, options?: FakeOptions): Promise<void>;
  sendCustomMessage(message: { customType: string; content: string }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
}

function install(driver: StableSdkDriver, session: FakeSession): void {
  (driver as unknown as { installExtensionAdmission(session: FakeSession): void }).installExtensionAdmission(session);
}

function capturingHandler(driver: StableSdkDriver): { requests: ExtensionModelWorkRequest[]; admissions: ExtensionModelAdmission[] } {
  const requests: ExtensionModelWorkRequest[] = [];
  const admissions: ExtensionModelAdmission[] = [];
  driver.setExtensionModelWorkHandler((request) => {
    requests.push(request);
    const execution = request.start(request.parent?.runId);
    const admission = {
      admission: execution.admission,
      completion: execution.completion.then(() => undefined),
    };
    void admission.completion.catch(() => undefined);
    admissions.push(admission);
    return admission;
  });
  return { requests, admissions };
}

describe("StableSdkDriver extension admission", () => {
  it("splits positive preflight admission from full native completion", async () => {
    const preflight = deferred();
    const turn = deferred();
    const driver = new StableSdkDriver();
    const session: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        await preflight.promise;
        options?.preflightResult?.(true);
        this.isStreaming = true;
        await turn.promise;
        this.isStreaming = false;
      },
      async sendCustomMessage() {},
    };
    install(driver, session);
    const captured = capturingHandler(driver);

    const admission = session.prompt("owned", { source: "extension" });
    let admitted = false;
    void admission.then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    preflight.resolve();
    await expect(admission).resolves.toBeUndefined();
    expect(captured.requests).toHaveLength(1);
    let completed = false;
    void captured.admissions[0]!.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    turn.resolve();
    await expect(captured.admissions[0]!.completion).resolves.toBeUndefined();
  });

  it("rejects false, void-without-callback, and thrown preflight without guessing from resolution", async () => {
    const cases: Array<(options?: FakeOptions) => Promise<void>> = [
      async (options) => { options?.preflightResult?.(false); },
      async () => {},
      async () => { throw new Error("auth refused"); },
    ];
    for (const native of cases) {
      const driver = new StableSdkDriver();
      const session: FakeSession = { isStreaming: false, prompt: native, async sendCustomMessage() {} };
      install(driver, session);
      const captured = capturingHandler(driver);
      await expect(session.prompt("owned", { source: "extension" })).rejects.toThrow();
      await expect(captured.admissions[0]!.completion).rejects.toThrow();
    }
  });

  it("keeps accepted late failure out of A and reports consumed acceptance without model events", async () => {
    const late = deferred();
    const driver = new StableSdkDriver();
    let mode: "late" | "consumed" = "late";
    const session: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        options?.preflightResult?.(true);
        if (mode === "late") {
          this.isStreaming = true;
          await late.promise;
          this.isStreaming = false;
          throw new Error("provider failed late");
        }
      },
      async sendCustomMessage() {},
    };
    install(driver, session);
    const captured = capturingHandler(driver);

    await expect(session.prompt("late", { source: "extension" })).resolves.toBeUndefined();
    late.resolve();
    await expect(captured.admissions[0]!.completion).rejects.toThrow("provider failed late");

    mode = "consumed";
    await expect(session.prompt("handled", { source: "extension" })).resolves.toBeUndefined();
    await expect(captured.admissions[1]!.completion).resolves.toBeUndefined();
    const execution = captured.requests[1]!.start;
    expect(execution).toBeTypeOf("function");
  });

  it("accepts idle custom triggers after the synchronous active transition and retains completion", async () => {
    const turn = deferred();
    const driver = new StableSdkDriver();
    const session: FakeSession = {
      isStreaming: false,
      async prompt() {},
      async sendCustomMessage() {
        this.isStreaming = true;
        await turn.promise;
        this.isStreaming = false;
      },
    };
    install(driver, session);
    const captured = capturingHandler(driver);
    const admission = session.sendCustomMessage({ customType: "wake", content: "done" }, { triggerTurn: true });
    await expect(admission).resolves.toBeUndefined();
    let completed = false;
    void captured.admissions[0]!.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    turn.resolve();
    await expect(captured.admissions[0]!.completion).resolves.toBeUndefined();
  });

  it("bypasses non-triggering custom messages", async () => {
    const native = vi.fn(async () => undefined);
    const driver = new StableSdkDriver();
    const session: FakeSession = { isStreaming: false, async prompt() {}, sendCustomMessage: native };
    install(driver, session);
    const handler = vi.fn();
    driver.setExtensionModelWorkHandler(handler);
    await session.sendCustomMessage({ customType: "record", content: "only" }, { triggerTurn: false });
    expect(native).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});
