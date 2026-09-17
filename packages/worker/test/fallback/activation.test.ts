/**
 * The activation boundaries, as policy rather than as engine behaviour
 * (M15-T3, M15-T7, `docs/model-fallback-chains.md` §2.1).
 *
 * `engine.test.ts` proves the same rules through the real engine and three
 * stub providers, which is what makes them true in production. This file
 * proves them on the controller itself, because two of them are invariants
 * the controller must keep whatever its caller believes: a traversal that has
 * already moved is never re-resolved, and a boundary that changes nothing
 * writes nothing. The driver reaches `activateForAcceptedSelection()` only on
 * a pristine session today; that precondition lives in another file, and this
 * is where the controller stops depending on it.
 */
import { SESSION_FALLBACK_ENTRY_TYPE, type FallbackChain, type FallbackModelRef, type SessionFallbackEntry, type SessionUpdate } from "@lasercode/protocol";
import { expect, it } from "vitest";

import { FallbackController, type FallbackEngine } from "../../src/fallback/controller.js";

const A: FallbackModelRef = { provider: "stub", id: "a" };
const B: FallbackModelRef = { provider: "stub", id: "b" };
const C: FallbackModelRef = { provider: "stub", id: "c" };
const CHAIN: FallbackChain[] = [{ models: [A, B] }];

/** Only the reads an activation makes; everything a failover needs would be a different test. */
function harness(selected: FallbackModelRef | null, chains: FallbackChain[] = CHAIN) {
  let model = selected;
  const entries: SessionFallbackEntry[] = [];
  const updates: SessionUpdate[] = [];
  let ids = 0;
  const engine: FallbackEngine = {
    chains: () => chains,
    selectedModel: () => model,
    catalogue: () => Promise.resolve(new Map()),
    names: () => new Map(),
    contextTokens: () => null,
    lastFailure: () => undefined,
    setModel: async (next) => { model = next; },
    abortTurn: () => {},
    continueTurn: async () => {},
    appendEntry: (entry) => { entries.push(entry); },
    emit: (update) => { updates.push(update); },
    now: () => 0,
    newId: () => `id-${++ids}`,
  };
  return { controller: new FallbackController(engine), entries, updates, select: (next: FallbackModelRef) => { model = next; } };
}

/** The session file's own last word, as `restore()` reads it. */
function savedEntry(entry: Partial<SessionFallbackEntry>): unknown {
  return {
    type: "custom",
    customType: SESSION_FALLBACK_ENTRY_TYPE,
    data: { version: 1, event: "activated", at: "2026-01-01T00:00:00.000Z", models: {}, activation: null, ...entry } satisfies SessionFallbackEntry,
  };
}

it("follows the model the accepted first turn is actually on", () => {
  // `open()` saw the global default; the agent accepted with the first turn
  // put the session on the chain's first model instead (M15-T7).
  const { controller, entries, select } = harness(C);
  controller.activateIfUnset();
  expect(controller.summary()).toBeUndefined();

  select(A);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toMatchObject({ position: 0, chain: [A, B] });
  // A provisional activation is what the next open would resolve again, so it
  // is not worth a line in the session file.
  expect(entries).toEqual([]);
});

it("leaves a traversal that has already moved alone", () => {
  // A session that failed over to B and was reloaded stands on B at position
  // 1. Re-resolving from the selected model would silently restart the chain.
  const { controller } = harness(B);
  controller.restore([savedEntry({ activation: { id: "saved", chainKey: "stub/a", startedAt: "2026-01-01T00:00:00.000Z", models: [A, B], position: 1 } })]);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toMatchObject({ position: 1, chain: [A, B] });
});

it("leaves a failover in flight alone", () => {
  const { controller } = harness(C);
  controller.restore([savedEntry({
    activation: { id: "saved", chainKey: "stub/a", startedAt: "2026-01-01T00:00:00.000Z", models: [A, B], position: 0 },
    failover: { id: "event", startedAt: "2026-01-01T00:00:00.000Z", attempts: [] },
  })]);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toMatchObject({ position: 0, chain: [A, B] });
});

it("changes nothing when the accepted model is the one it already activated", () => {
  const { controller, entries, updates } = harness(A);
  controller.activateIfUnset();
  const before = controller.summary();
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toEqual(before);
  expect(entries).toEqual([]);
  expect(updates).toEqual([]);
});

it("clears a provisional activation when the accepted model starts no chain", () => {
  const { controller, select } = harness(A);
  controller.activateIfUnset();
  expect(controller.summary()).toMatchObject({ position: 0 });
  select(C);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toBeUndefined();
});
