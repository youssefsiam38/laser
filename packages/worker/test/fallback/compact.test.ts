/**
 * Size recovery on fallback exhaustion (M15-T8): one compact under a candidate
 * blocked only by context size, then the shared continuation path.
 */
import { expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  SESSION_FALLBACK_ENTRY_TYPE,
  modelKey,
  type FallbackChain,
  type FallbackModelRef,
  type ProviderFailureSignal,
  type SessionFallbackEntry,
  type SessionUpdate,
} from "@lasercode/protocol";

import { FallbackController, type FallbackEngine } from "../../src/fallback/controller.js";
import { dropTrailingErrorAssistant } from "../../src/fallback/engine-port.js";
import { CONTEXT_TOO_LONG_REASON, type CandidateModel } from "../../src/fallback/policy.js";

const A: FallbackModelRef = { provider: "stub", id: "a" };
const B: FallbackModelRef = { provider: "stub", id: "b" };
const C: FallbackModelRef = { provider: "stub", id: "c" };
const D: FallbackModelRef = { provider: "stub", id: "d" };

const ACCESS: ProviderFailureSignal = { errorMessage: "Internal server error", response: { status: 500, headers: {} } };
const OVERFLOW: ProviderFailureSignal = { errorMessage: "maximum context length exceeded" };
const RATE: ProviderFailureSignal = { errorMessage: "rate limit", response: { status: 429, headers: {} } };

function savedEntry(entry: Partial<SessionFallbackEntry>): unknown {
  return {
    type: "custom",
    customType: SESSION_FALLBACK_ENTRY_TYPE,
    data: { version: 1, event: "activated", at: "2026-01-01T00:00:00.000Z", models: {}, activation: null, ...entry } satisfies SessionFallbackEntry,
  };
}

function catalogue(
  refs: FallbackModelRef[],
  windows: Record<string, number>,
  extras: Partial<Record<string, Partial<CandidateModel>>> = {},
): Map<string, CandidateModel> {
  const entries = new Map<string, CandidateModel>();
  for (const ref of refs) {
    const key = modelKey(ref);
    entries.set(key, {
      ref,
      signedIn: true,
      offered: true,
      contextWindow: windows[ref.id] ?? 200_000,
      ...extras[key],
    });
  }
  return entries;
}

function namesOf(refs: FallbackModelRef[]): Map<string, FallbackModelRef & { name: string }> {
  return new Map(refs.map((ref) => [modelKey(ref), { ...ref, name: `Stub ${ref.id.toUpperCase()}` }]));
}

interface Harness {
  controller: FallbackController;
  updates: SessionUpdate[];
  entries: SessionFallbackEntry[];
  setModels: FallbackModelRef[];
  continues: Array<{ retries: "none" | "normal" }>;
  compacts: number;
  settle: () => Promise<boolean>;
}

function harness(over: {
  models?: FallbackModelRef[];
  position?: number;
  tokens?: number | null;
  windows?: Record<string, number>;
  extras?: Partial<Record<string, Partial<CandidateModel>>>;
  auto?: boolean;
  failure?: ProviderFailureSignal | undefined;
  compact?: (signal: AbortSignal) => Promise<{ estimatedTokensAfter: number }>;
  setModel?: (model: FallbackModelRef) => Promise<void>;
  continueTurn?: (options: { retries: "none" | "normal"; signal: AbortSignal }) => Promise<void>;
  afterContinueFailure?: () => ProviderFailureSignal | undefined;
  catalogue?: () => ReadonlyMap<string, CandidateModel> | Promise<ReadonlyMap<string, CandidateModel>>;
}): Harness {
  const models = over.models ?? [A, B, C];
  const chains: FallbackChain[] = [{ models }];
  let selected = models[over.position ?? 0] ?? A;
  let failure: ProviderFailureSignal | undefined = over.failure === undefined ? ACCESS : over.failure;
  const updates: SessionUpdate[] = [];
  const entries: SessionFallbackEntry[] = [];
  const setModels: FallbackModelRef[] = [];
  const continues: Array<{ retries: "none" | "normal" }> = [];
  let compacts = 0;
  let ids = 0;
  const engine: FallbackEngine = {
    chains: () => chains,
    selectedModel: () => selected,
    catalogue: async () => over.catalogue ? over.catalogue() : catalogue(models, over.windows ?? {}, over.extras),
    names: () => namesOf(models),
    contextTokens: () => (over.tokens === undefined ? 50_000 : over.tokens),
    lastFailure: () => failure,
    setModel: async (next) => {
      setModels.push(next);
      if (over.setModel) await over.setModel(next);
      selected = next;
    },
    abortTurn: () => {},
    continueTurn: async (options) => {
      continues.push({ retries: options.retries });
      if (over.continueTurn) await over.continueTurn(options);
      failure = over.afterContinueFailure ? over.afterContinueFailure() : undefined;
    },
    autoCompactionEnabled: () => over.auto ?? true,
    compact: async (signal) => {
      compacts += 1;
      if (over.compact) return over.compact(signal);
      return { estimatedTokensAfter: 100 };
    },
    appendEntry: (entry) => { entries.push(entry); },
    emit: (update) => { updates.push(update); },
    now: () => Date.parse("2026-09-11T12:00:00.000Z"),
    newId: () => `id-${++ids}`,
  };
  const controller = new FallbackController(engine);
  if ((over.position ?? 0) > 0) {
    controller.restore([savedEntry({
      activation: {
        id: "saved",
        chainKey: modelKey(models[0]!),
        startedAt: "2026-01-01T00:00:00.000Z",
        models,
        position: over.position ?? 0,
      },
    })]);
  } else {
    controller.activateIfUnset();
  }
  return {
    controller,
    updates,
    entries,
    setModels,
    continues,
    get compacts() { return compacts; },
    settle: () => controller.settle(),
  };
}

function fallbacks(updates: SessionUpdate[]) {
  return updates.filter((update): update is Extract<SessionUpdate, { kind: "model_fallback" }> => update.kind === "model_fallback");
}

it("compacts once under B then continues B without a second setModel", async () => {
  const h = harness({
    windows: { a: 200_000, b: 8_000, c: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
  });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(1);
  expect(h.setModels).toEqual([B]);
  expect(h.continues).toEqual([{ retries: "normal" }]);
  expect(fallbacks(h.updates).map((event) => event.phase)).toEqual(["switching", "switched"]);
  expect(fallbacks(h.updates).at(-1)?.to?.id).toBe("b");
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(B) && attempt.outcome === "failed"))).toBe(false);
  const attempts = h.entries.at(-1)?.failover?.attempts ?? [];
  expect(attempts.filter((attempt) => attempt.model === modelKey(C) && attempt.outcome === "skipped" && attempt.reason === "not signed in")).toHaveLength(1);
});

it("keeps the original access failure and B's size skip when compact throws", async () => {
  const h = harness({
    windows: { a: 200_000, b: 8_000, c: 200_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
    compact: async () => { throw new Error("Nothing to compact"); },
  });
  expect(await h.settle()).toBe(false);
  expect(h.continues).toEqual([]);
  expect(h.compacts).toBe(1);
  const exhausted = fallbacks(h.updates).at(-1)!;
  expect(exhausted.phase).toBe("exhausted");
  expect(exhausted.reason).toBe("provider_down");
  expect(exhausted.detail).toContain("Stub A is not answering");
  expect(exhausted.detail).toContain(`Stub B ${CONTEXT_TOO_LONG_REASON}`);
  expect(exhausted.detail).toContain("Stub C not signed in");
  expect((exhausted.detail?.match(new RegExp(CONTEXT_TOO_LONG_REASON, "g")) ?? []).length).toBe(1);
  const attempts = h.entries.at(-1)?.failover?.attempts ?? [];
  expect(attempts.filter((attempt) => attempt.model === modelKey(C) && attempt.outcome === "skipped" && attempt.reason === "not signed in")).toHaveLength(1);
});

it("does not compact when auto-compaction is off", async () => {
  const h = harness({
    auto: false,
    windows: { b: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
  });
  expect(await h.settle()).toBe(false);
  expect(h.compacts).toBe(0);
  expect(h.setModels).toEqual([]);
  expect(fallbacks(h.updates).at(-1)?.detail).toContain(CONTEXT_TOO_LONG_REASON);
});

it("aborts compact when the failover is cancelled", async () => {
  let compactStarted!: () => void;
  const started = new Promise<void>((resolve) => { compactStarted = resolve; });
  const h = harness({
    windows: { b: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
    compact: async (signal) => {
      await new Promise<never>((_, reject) => {
        const fail = () => reject(new Error("aborted"));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail);
        compactStarted();
      });
    },
  });
  const settling = h.settle();
  await started;
  h.controller.cancel();
  expect(await settling).toBe(false);
  expect(fallbacks(h.updates).some((event) => event.phase === "exhausted")).toBe(false);
});

it("gives a manual selection the last word during compact", async () => {
  let compactStarted!: () => void;
  const started = new Promise<void>((resolve) => { compactStarted = resolve; });
  const h = harness({
    windows: { b: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
    compact: async (signal) => {
      await new Promise<never>((_, reject) => {
        const fail = () => reject(new Error("aborted"));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail);
        compactStarted();
      });
    },
  });
  const settling = h.settle();
  await started;
  h.controller.onManualSelection(C);
  expect(await settling).toBe(false);
  expect(fallbacks(h.updates).some((event) => event.phase === "switched")).toBe(false);
  expect(h.controller.summary()).toBeUndefined();
});

it("records B's size skip and keeps other reasons when the estimate still exceeds B", async () => {
  const h = harness({
    windows: { b: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
    compact: async () => ({ estimatedTokensAfter: 90_000 }),
  });
  expect(await h.settle()).toBe(false);
  expect(h.continues).toEqual([]);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(B) && attempt.outcome === "skipped" && attempt.reason === CONTEXT_TOO_LONG_REASON))).toBe(true);
  const exhausted = fallbacks(h.updates).at(-1)!;
  expect(exhausted.phase).toBe("exhausted");
  expect(exhausted.detail).toContain(`Stub B ${CONTEXT_TOO_LONG_REASON}`);
  expect(exhausted.detail).toContain("Stub C not signed in");
  expect((exhausted.detail?.match(new RegExp(CONTEXT_TOO_LONG_REASON, "g")) ?? []).length).toBe(1);
});

it("does not compact when a later model already fits", async () => {
  const h = harness({ windows: { b: 8_000, c: 200_000 }, tokens: 50_000 });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(0);
  expect(h.setModels).toEqual([C]);
  expect(h.continues).toEqual([{ retries: "normal" }]);
});

it("does not call continueTurn from compact itself", async () => {
  const h = harness({ windows: { b: 8_000 }, tokens: 50_000, extras: { [modelKey(C)]: { signedIn: false } } });
  await h.settle();
  expect(h.compacts).toBe(1);
  expect(h.continues).toHaveLength(1);
});

it("treats a missing compact estimate as compact failure, not a blind attempt", async () => {
  const h = harness({
    windows: { b: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
    compact: async () => ({ estimatedTokensAfter: Number.NaN }),
  });
  expect(await h.settle()).toBe(false);
  expect(h.continues).toEqual([]);
  expect(fallbacks(h.updates).at(-1)?.detail).toContain(CONTEXT_TOO_LONG_REASON);
});

it("manual selection fences an invalid estimate even when compact resolves", async () => {
  let compactStarted!: () => void;
  let releaseCompact!: () => void;
  const started = new Promise<void>((resolve) => { compactStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCompact = resolve; });
  const h = harness({
    windows: { b: 8_000 },
    tokens: 50_000,
    extras: { [modelKey(C)]: { signedIn: false } },
    compact: async () => {
      compactStarted();
      await release;
      return { estimatedTokensAfter: Number.NaN };
    },
  });
  const settling = h.settle();
  await started;
  h.controller.onManualSelection(C);
  releaseCompact();
  expect(await settling).toBe(false);
  expect(fallbacks(h.updates).some((event) => event.phase === "exhausted")).toBe(false);
});

it("does not open failover on context overflow even when auto-compaction is on", async () => {
  const h = harness({ failure: OVERFLOW, windows: { b: 8_000 }, tokens: 50_000 });
  expect(await h.settle()).toBe(false);
  expect(h.compacts).toBe(0);
  expect(fallbacks(h.updates)).toEqual([]);
});

it("compacts under the second oversized candidate when the first cannot be selected", async () => {
  const h = harness({
    windows: { b: 8_000, c: 8_000 },
    tokens: 50_000,
    setModel: async (model) => {
      if (model.id === "b") throw new Error("gone");
    },
  });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(1);
  expect(h.setModels).toEqual([B, C]);
  expect(h.continues).toEqual([{ retries: "normal" }]);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(B) && attempt.outcome === "failed" && attempt.class === "credential"))).toBe(true);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(C) && attempt.outcome === "succeeded"))).toBe(true);
});

it("records B's access failure after a fitting compact and continues the traversal", async () => {
  let continues = 0;
  const h = harness({
    windows: { b: 8_000, c: 8_000 },
    tokens: 50_000,
    continueTurn: async () => {
      continues += 1;
    },
    afterContinueFailure: () => (continues === 1 ? RATE : undefined),
  });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(1);
  expect(h.setModels.map((model) => model.id)).toEqual(["b", "c"]);
  expect(h.continues).toEqual([{ retries: "normal" }, { retries: "normal" }]);
  expect(fallbacks(h.updates).some((event) => event.phase === "attempt_failed" && event.to?.id === "b")).toBe(true);
  expect(fallbacks(h.updates).at(-1)).toMatchObject({ phase: "switched", to: expect.objectContaining({ id: "c" }) });
});

it("continues an earlier oversized model with a bounded return", async () => {
  const h = harness({
    models: [A, B, C],
    position: 2,
    windows: { b: 8_000, c: 200_000 },
    tokens: 50_000,
    extras: { [modelKey(A)]: { signedIn: false } },
  });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(1);
  expect(h.setModels).toEqual([B]);
  expect(h.continues).toEqual([{ retries: "none" }]);
  expect(fallbacks(h.updates).at(-1)?.phase).toBe("switched");
});

it("re-enters traversal when the compact estimate still exceeds B but fits C", async () => {
  const h = harness({
    windows: { b: 1_000, c: 8_000 },
    tokens: 50_000,
    compact: async () => ({ estimatedTokensAfter: 4_000 }),
  });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(1);
  expect(h.setModels.map((model) => model.id)).toEqual(["b", "c"]);
  expect(h.continues).toEqual([{ retries: "normal" }]);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(B) && attempt.outcome === "skipped" && attempt.reason === CONTEXT_TOO_LONG_REASON))).toBe(true);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(C) && attempt.outcome === "succeeded"))).toBe(true);
});

it("exhausts after one compact when B and C both remain too large", async () => {
  const h = harness({
    windows: { b: 1_000, c: 2_000 },
    tokens: 50_000,
    compact: async () => ({ estimatedTokensAfter: 4_000 }),
  });
  expect(await h.settle()).toBe(false);
  expect(h.compacts).toBe(1);
  expect(h.continues).toEqual([]);
  const detail = fallbacks(h.updates).at(-1)?.detail ?? "";
  expect(detail.match(new RegExp(`Stub B ${CONTEXT_TOO_LONG_REASON}`, "g"))).toHaveLength(1);
  expect(detail.match(new RegExp(`Stub C ${CONTEXT_TOO_LONG_REASON}`, "g"))).toHaveLength(1);
});

it("does not claim B was merely too large after its selection was refused", async () => {
  const h = harness({
    windows: { b: 8_000, c: 8_000 },
    tokens: 50_000,
    setModel: async (model) => {
      if (model.id === "b") throw new Error("gone");
    },
    compact: async () => { throw new Error("Nothing to compact"); },
  });
  expect(await h.settle()).toBe(false);
  expect(h.compacts).toBe(1);
  expect(h.setModels.map((model) => model.id)).toEqual(["b", "c"]);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(B) && attempt.outcome === "failed" && attempt.class === "credential"))).toBe(true);
  const exhausted = fallbacks(h.updates).at(-1)!;
  expect(exhausted.phase).toBe("exhausted");
  expect(exhausted.detail).not.toContain(`Stub B ${CONTEXT_TOO_LONG_REASON}`);
  expect(exhausted.detail).toContain(`Stub C ${CONTEXT_TOO_LONG_REASON}`);
  expect((exhausted.detail?.match(new RegExp(CONTEXT_TOO_LONG_REASON, "g")) ?? []).length).toBe(1);
});

it("uses the catalogue snapshot that classified B, not a later one", async () => {
  const models = [A, B, C];
  const initiating = catalogue(models, { a: 200_000, b: 1_000, c: 8_000 });
  const later = catalogue(models, { a: 200_000, b: 200_000, c: 8_000 });
  let calls = 0;
  const h = harness({
    tokens: 50_000,
    compact: async () => ({ estimatedTokensAfter: 4_000 }),
    catalogue: () => {
      calls += 1;
      return calls === 1 ? initiating : later;
    },
  });
  expect(await h.settle()).toBe(true);
  expect(h.compacts).toBe(1);
  expect(h.setModels.map((model) => model.id)).toEqual(["b", "c"]);
  expect(h.continues).toEqual([{ retries: "normal" }]);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(B) && attempt.outcome === "skipped" && attempt.reason === CONTEXT_TOO_LONG_REASON))).toBe(true);
  expect(h.entries.some((entry) => entry.failover?.attempts.some((attempt) => attempt.model === modelKey(C) && attempt.outcome === "succeeded"))).toBe(true);
});

it("retains a preceding successful assistant when dropping the trailing error", () => {
  const ok = { role: "assistant", stopReason: "stop" };
  const err = { role: "assistant", stopReason: "error" };
  const retry = { role: "assistant", stopReason: "error" };
  const session = { agent: { state: { messages: [{ role: "user" }, ok, err, retry] } } } as unknown as AgentSession;
  dropTrailingErrorAssistant(session);
  expect(session.agent.state.messages).toEqual([{ role: "user" }, ok]);
});
