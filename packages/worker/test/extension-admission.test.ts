import { describe, expect, it, vi } from "vitest";
import type { DriverInvocationRef, ExtensionModelAdmission, ExtensionModelWorkRequest } from "../src/driver.js";
import { StableExtensionAdmission, type StableInvocation } from "../src/drivers/stable-extension-admission.js";

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

function capturingHandler(admission: StableExtensionAdmission): {
  requests: ExtensionModelWorkRequest[];
  admissions: ExtensionModelAdmission[];
  refs: DriverInvocationRef[];
} {
  const requests: ExtensionModelWorkRequest[] = [];
  const admissions: ExtensionModelAdmission[] = [];
  const refs: DriverInvocationRef[] = [];
  admission.setHandler((request) => {
    requests.push(request);
    const execution = request.start(request.parent?.runId, (ref) => refs.push(ref));
    const result = {
      admission: execution.admission,
      completion: execution.completion.then(() => undefined),
      joinsParent: true,
    };
    void result.completion.catch(() => undefined);
    admissions.push(result);
    return result;
  });
  return { requests, admissions, refs };
}

/**
 * The shape of the pinned engine's own rejection observer: `bindCore` attaches
 * `.then(undefined, …)` to the operation synchronously at the sender's call
 * site, so the diagnostic runs in the sender's async context.
 */
function diagnose(admission: StableExtensionAdmission, operation: Promise<void>): Promise<DriverInvocationRef | undefined> {
  const stamp = operation.then(() => undefined, () => admission.diagnosticInvocation());
  return stamp;
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

  it("settles admission and completion when the engine reports a false preflight and then resolves", async () => {
    // The native method is invoked as `prompt(text, options)`: a fake that
    // takes `options` first receives the text and never sees the callback.
    const preflight = vi.fn<(accepted: boolean) => void>();
    const admission = new StableExtensionAdmission();
    let verdict = false;
    let refused: StableInvocation | undefined;
    const session: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        const report = options?.preflightResult;
        expect(typeof report).toBe("function");
        if (!verdict) refused = admission.currentInvocation();
        preflight(verdict);
        report?.(verdict);
      },
      async sendCustomMessage() {},
    };
    install(admission, session);
    const captured = capturingHandler(admission);
    await expect(session.prompt("owned", { source: "extension" })).rejects.toThrow(/refused before model ownership/);
    expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
    await expect(captured.admissions[0]!.completion).rejects.toThrow(/refused before model ownership/);

    // The refused invocation released everything it held.
    expect(refused).toBeDefined();
    expect(refused!.active).toBe(false);
    expect(refused!.children.size).toBe(0);
    expect(admission.currentInvocation()).toBeUndefined();

    // Nothing was retained: the next legitimate admission on the same helper is accepted.
    verdict = true;
    await expect(session.prompt("accepted next", { source: "extension" })).resolves.toBeUndefined();
    expect(preflight).toHaveBeenLastCalledWith(true);
    await expect(captured.admissions[1]!.completion).resolves.toBeUndefined();
    expect(captured.refs[0]!.id).not.toBe(captured.refs[1]!.id);
  });

  it("rejects void-without-callback and thrown preflight without guessing from resolution", async () => {
    const cases: Array<(text: string, options?: FakeOptions) => Promise<void>> = [
      async (_text, _options) => {},
      async (_text, _options) => { throw new Error("auth refused"); },
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

  it("refuses a streaming custom trigger whose native send fails before acceptance", async () => {
    const admission = new StableExtensionAdmission();
    const session: FakeSession = {
      isStreaming: true,
      async prompt() {},
      async sendCustomMessage() {
        throw new Error("steer queue closed");
      },
    };
    install(admission, session);
    const captured = capturingHandler(admission);
    await expect(session.sendCustomMessage({ customType: "wake", content: "queued" }, { triggerTurn: true })).rejects.toThrow("steer queue closed");
    await expect(captured.admissions[0]!.completion).rejects.toThrow("steer queue closed");
    expect(admission.currentInvocation()).toBeUndefined();
  });

  it("keeps a streaming custom trigger accepted when a causal child fails after the engine queued it", async () => {
    const late = deferred();
    const admission = new StableExtensionAdmission();
    const session: FakeSession = {
      isStreaming: true,
      async prompt(_text, options) {
        options?.preflightResult?.(true);
        await late.promise;
        throw new Error("child failed late");
      },
      async sendCustomMessage() {
        // While queueing the trigger, the extension makes a causal send.
        await session.prompt("child", { source: "extension", streamingBehavior: "steer" });
      },
    };
    install(admission, session);
    const captured = capturingHandler(admission);
    const accepted = session.sendCustomMessage({ customType: "wake", content: "queued" }, { triggerTurn: true });
    await expect(accepted).resolves.toBeUndefined();
    let completion: "pending" | "resolved" | "rejected" = "pending";
    void captured.admissions[0]!.completion.then(() => { completion = "resolved"; }, () => { completion = "rejected"; });
    await settled();
    expect(completion).toBe("pending");
    late.resolve();
    await expect(captured.admissions[0]!.completion).rejects.toThrow("child failed late");
    await expect(accepted).resolves.toBeUndefined();
    expect(captured.requests.map((request) => request.kind)).toEqual(["custom", "user"]);
    expect(captured.requests[1]!.parent).toEqual(captured.refs[0]);
  });

  it("refuses an idle custom trigger the engine resolves without starting", async () => {
    const admission = new StableExtensionAdmission();
    const session: FakeSession = { isStreaming: false, async prompt() {}, async sendCustomMessage() {} };
    install(admission, session);
    const captured = capturingHandler(admission);
    await expect(session.sendCustomMessage({ customType: "wake", content: "idle" }, { triggerTurn: true })).rejects.toThrow(/did not start/);
    await expect(captured.admissions[0]!.completion).rejects.toThrow(/did not start/);
  });

  it("leaves identical top-level refusals unowned and attributes a nested refusal to its causal invocation, never by text", async () => {
    const admission = new StableExtensionAdmission();
    const session: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        options?.preflightResult?.(false);
        throw new Error("same text");
      },
      async sendCustomMessage() {},
    };
    install(admission, session);
    const captured = capturingHandler(admission);
    const first = diagnose(admission, session.prompt("one", { source: "extension" }));
    const second = diagnose(admission, session.prompt("two", { source: "extension" }));
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(captured.refs).toHaveLength(2);
    expect(captured.refs[0]!.id).not.toBe(captured.refs[1]!.id);

    const parent = admission.createInvocation({ ownerRunId: "run-parent", origin: "agent", task: "parent", accept: () => {} });
    let nested: Promise<DriverInvocationRef | undefined> | undefined;
    await admission.runInvocation(parent, async () => {
      nested = diagnose(admission, session.prompt("three", { source: "extension" }));
      await nested;
    }, true).catch(() => undefined);
    expect(await nested!).toEqual(parent.ref);
    expect(captured.refs[2]!.id).not.toBe(parent.ref.id);
    expect(captured.requests[2]!.parent).toEqual(parent.ref);
    expect(admission.diagnosticInvocation()).toBeUndefined();
  });

  it("keeps delayed and reordered diagnostics in their own call context", async () => {
    const admission = new StableExtensionAdmission();
    const gates = [deferred(), deferred()];
    const session: FakeSession = {
      isStreaming: false,
      async prompt(text, options) {
        await gates[Number(text)]!.promise;
        options?.preflightResult?.(false);
        throw new Error("same text");
      },
      async sendCustomMessage() {},
    };
    install(admission, session);
    capturingHandler(admission);
    const parents = [0, 1].map((index) => admission.createInvocation({ ownerRunId: `run-${index}`, origin: "agent", task: `parent ${index}`, accept: () => {} }));
    const stamps: Array<Promise<DriverInvocationRef | undefined>> = [];
    const runs = parents.map((parent, index) => admission.runInvocation(parent, async () => {
      stamps[index] = diagnose(admission, session.prompt(String(index), { source: "extension" }));
    }, true).catch(() => undefined));
    // The second send fails first, the first send later; each names its own sender.
    gates[1]!.resolve();
    expect(await stamps[1]!).toEqual(parents[1]!.ref);
    gates[0]!.resolve();
    expect(await stamps[0]!).toEqual(parents[0]!.ref);
    await Promise.all(runs);
  });

  it("does not hand an accepted late failure's identity to a later refusal with the same text", async () => {
    const late = deferred();
    const admission = new StableExtensionAdmission();
    let mode: "late" | "refuse" = "late";
    const session: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        if (mode === "late") {
          options?.preflightResult?.(true);
          this.isStreaming = true;
          await late.promise;
          this.isStreaming = false;
          throw new Error("same text");
        }
        options?.preflightResult?.(false);
        throw new Error("same text");
      },
      async sendCustomMessage() {},
    };
    install(admission, session);
    const captured = capturingHandler(admission);
    const first = session.prompt("accepted", { source: "extension" });
    const firstStamp = diagnose(admission, first);
    await expect(first).resolves.toBeUndefined();
    late.resolve();
    await expect(captured.admissions[0]!.completion).rejects.toThrow("same text");

    mode = "refuse";
    const secondStamp = diagnose(admission, session.prompt("refused", { source: "extension" }));
    expect(await secondStamp).toBeUndefined();
    expect(await firstStamp).toBeUndefined();
    expect(captured.refs[1]!.id).not.toBe(captured.refs[0]!.id);
    expect(admission.diagnosticInvocation()).toBeUndefined();
  });

  it("carries no association across invalidate() into a later generation", async () => {
    const admission = new StableExtensionAdmission();
    const gate = deferred();
    const first: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        await gate.promise;
        options?.preflightResult?.(false);
        throw new Error("same text");
      },
      async sendCustomMessage() {},
    };
    install(admission, first);
    const captured = capturingHandler(admission);
    const parent = admission.createInvocation({ ownerRunId: "run-old", origin: "agent", task: "old", accept: () => {} });
    let oldStamp: Promise<DriverInvocationRef | undefined> | undefined;
    const oldRun = admission.runInvocation(parent, async () => {
      oldStamp = diagnose(admission, first.prompt("old", { source: "extension" }));
    }, true).catch(() => undefined);
    const oldRef = captured.refs[0]!;

    admission.invalidate();
    const second: FakeSession = {
      isStreaming: false,
      async prompt(_text, options) {
        options?.preflightResult?.(false);
        throw new Error("same text");
      },
      async sendCustomMessage() {},
    };
    install(admission, second);
    expect(await diagnose(admission, second.prompt("new", { source: "extension" }))).toBeUndefined();
    const newRef = captured.refs[1]!;
    expect(newRef.id.split(":")[0]).not.toBe(oldRef.id.split(":")[0]);

    // The old generation's refusal lands late, in its own context: the live generation has nothing to own.
    gate.resolve();
    expect(await oldStamp!).toBeUndefined();
    await oldRun;
    expect(admission.diagnosticInvocation()).toBeUndefined();
  });

  it("names a drained invocation's own context for a late diagnostic, never the live successor", async () => {
    const admission = new StableExtensionAdmission();
    const session: FakeSession = { isStreaming: false, async prompt() {}, async sendCustomMessage() {} };
    install(admission, session);
    const drained = admission.createInvocation({ ownerRunId: "run-old", origin: "agent", task: "old", accept: () => {} });
    const lateFailure = deferred();
    let lateStamp: Promise<DriverInvocationRef | undefined> | undefined;
    await admission.runInvocation(drained, async () => {
      // Registered inside this invocation, the way the engine's observer is; it fires after the drain.
      lateStamp = lateFailure.promise.then(() => undefined, () => admission.diagnosticInvocation());
    }, true);
    expect(drained.active).toBe(false);

    const successor = admission.createInvocation({ ownerRunId: "run-new", origin: "agent", task: "new", accept: () => {} });
    const hold = deferred();
    const running = admission.runInvocation(successor, async () => {
      expect(admission.currentInvocation()).toBe(successor);
      lateFailure.reject(new Error("old failure"));
      await lateStamp;
      await hold.promise;
    }, true);
    expect(await lateStamp!).toEqual(drained.ref);
    expect(drained.ref.id).not.toBe(successor.ref.id);
    hold.resolve();
    await running;
  });
});
