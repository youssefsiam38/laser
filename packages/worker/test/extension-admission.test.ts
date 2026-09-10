import { describe, expect, it, vi } from "vitest";
import type { ExtensionModelAdmission, ExtensionModelWorkRequest } from "../src/driver.js";
import { StableExtensionAdmission } from "../src/drivers/stable-extension-admission.js";

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

function install(admission: StableExtensionAdmission, session: FakeSession): void {
  admission.install(session as unknown as Parameters<StableExtensionAdmission["install"]>[0]);
}

function capturingHandler(admission: StableExtensionAdmission): { requests: ExtensionModelWorkRequest[]; admissions: ExtensionModelAdmission[] } {
  const requests: ExtensionModelWorkRequest[] = [];
  const admissions: ExtensionModelAdmission[] = [];
  admission.setHandler((request) => {
    requests.push(request);
    const execution = request.start(request.parent?.runId);
    const result = {
      admission: execution.admission,
      completion: execution.completion.then(() => undefined),
      joinsParent: true,
    };
    void result.completion.catch(() => undefined);
    admissions.push(result);
    return result;
  });
  return { requests, admissions };
}

describe("StableSdkDriver extension admission", () => {
  it("splits positive preflight admission from full native completion", async () => {
    const preflight = deferred();
    const turn = deferred();
    const admission = new StableExtensionAdmission();
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
    install(admission, session);
    const captured = capturingHandler(admission);

    const accepted = session.prompt("owned", { source: "extension" });
    let admitted = false;
    void accepted.then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    preflight.resolve();
    await expect(accepted).resolves.toBeUndefined();
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
      const admission = new StableExtensionAdmission();
      const session: FakeSession = { isStreaming: false, prompt: native, async sendCustomMessage() {} };
      install(admission, session);
      const captured = capturingHandler(admission);
      await expect(session.prompt("owned", { source: "extension" })).rejects.toThrow();
      await expect(captured.admissions[0]!.completion).rejects.toThrow();
    }
  });

  it("keeps accepted late failure out of A and reports consumed acceptance without model events", async () => {
    const late = deferred();
    const admission = new StableExtensionAdmission();
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
    install(admission, session);
    const captured = capturingHandler(admission);

    await expect(session.prompt("late", { source: "extension" })).resolves.toBeUndefined();
    late.resolve();
    await expect(captured.admissions[0]!.completion).rejects.toThrow("provider failed late");

    mode = "consumed";
    await expect(session.prompt("handled", { source: "extension" })).resolves.toBeUndefined();
    await expect(captured.admissions[1]!.completion).resolves.toBeUndefined();
  });

  it("accepts idle custom triggers after the synchronous active transition and retains completion", async () => {
    const turn = deferred();
    const admission = new StableExtensionAdmission();
    const session: FakeSession = {
      isStreaming: false,
      async prompt() {},
      async sendCustomMessage() {
        this.isStreaming = true;
        await turn.promise;
        this.isStreaming = false;
      },
    };
    install(admission, session);
    const captured = capturingHandler(admission);
    const accepted = session.sendCustomMessage({ customType: "wake", content: "done" }, { triggerTurn: true });
    await expect(accepted).resolves.toBeUndefined();
    let completed = false;
    void captured.admissions[0]!.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    turn.resolve();
    await expect(captured.admissions[0]!.completion).resolves.toBeUndefined();
  });

  it("does not drain successor completion as a causal child", async () => {
    const admission = new StableExtensionAdmission();
    const session: FakeSession = { isStreaming: false, async prompt() {}, async sendCustomMessage() {} };
    install(admission, session);
    const successor = deferred();
    admission.setHandler(() => ({
      admission: Promise.resolve(),
      completion: successor.promise,
      joinsParent: false,
    }));
    const parent = admission.createInvocation({ ownerRunId: "old", origin: "agent", task: "old", accept: () => {} });
    await expect(admission.runInvocation(
      parent,
      () => session.prompt("late", { source: "extension" }),
      true,
    )).resolves.toBeUndefined();
    successor.resolve();
  });

  it("bypasses non-triggering custom messages", async () => {
    const native = vi.fn(async () => undefined);
    const admission = new StableExtensionAdmission();
    const session: FakeSession = { isStreaming: false, async prompt() {}, sendCustomMessage: native };
    install(admission, session);
    const handler = vi.fn();
    admission.setHandler(handler);
    await session.sendCustomMessage({ customType: "record", content: "only" }, { triggerTurn: false });
    expect(native).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});
