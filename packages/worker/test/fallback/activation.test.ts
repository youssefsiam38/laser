/**
 * The activation boundaries, as policy rather than as engine behaviour
 * (`docs/model-profiles.md` "Runtime"; the mechanics are M15-T3/M15-T7's).
 *
 * `engine.test.ts` proves the same rules through the real engine and three
 * stub providers, which is what makes them true in production. This file
 * proves them on the controller itself, because several of them are invariants
 * the controller must keep whatever its caller believes: a traversal that has
 * already moved is never re-resolved, a boundary that changes nothing writes
 * nothing, and a pin leaves no profile behind it.
 */
import {
  SESSION_FALLBACK_ENTRY_TYPE,
  type ModelIdentity,
  type ModelProfile,
  type SessionFallbackEntry,
  type SessionUpdate,
} from "@lasercode/protocol";
import { expect, it } from "vitest";

import { FallbackController, type FallbackEngine } from "../../src/fallback/controller.js";

const A: ModelIdentity = { provider: "stub", id: "a" };
const B: ModelIdentity = { provider: "stub", id: "b" };
const C: ModelIdentity = { provider: "stub", id: "c" };

const BALANCED: ModelProfile = {
  id: "mp_01jbalanced0000000000000",
  name: "Balanced",
  models: [A, B],
  origin: "seeded",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const OTHER: ModelProfile = {
  id: "mp_01jother00000000000000d",
  name: "Local models",
  models: [C],
  origin: "person",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Only the reads an activation makes; everything a move needs would be a different test. */
/** Only A is unusable here, so a start-time walk has exactly one skip to record. */
const catalogue = new Map([
  ["stub/a", { ref: A, signedIn: false, offered: true }],
  ["stub/b", { ref: B, signedIn: true, offered: true }],
  ["stub/c", { ref: C, signedIn: true, offered: true }],
]);

function harness(selected: ModelIdentity | null, profile: ModelProfile | null = BALANCED) {
  let model = selected;
  let current = profile;
  const entries: SessionFallbackEntry[] = [];
  const updates: SessionUpdate[] = [];
  let ids = 0;
  const engine: FallbackEngine = {
    profile: () => current,
    selectedModel: () => model,
    catalogue: () => Promise.resolve(catalogue),
    names: () => new Map(),
    contextTokens: () => null,
    lastFailure: () => undefined,
    setModel: async (next) => { model = next; },
    abortTurn: () => {},
    continueTurn: async () => {},
    autoCompactionEnabled: () => true,
    compact: async () => ({ estimatedTokensAfter: 0 }),
    appendEntry: (entry) => { entries.push(entry); },
    emit: (update) => { updates.push(update); },
    now: () => 0,
    newId: () => `id-${++ids}`,
  };
  return {
    controller: new FallbackController(engine),
    entries,
    updates,
    select: (next: ModelIdentity) => { model = next; },
    setProfile: (next: ModelProfile | null) => { current = next; },
  };
}

/** The session file's own last word, as `restore()` reads it. */
function savedEntry(entry: Partial<SessionFallbackEntry>): unknown {
  return {
    type: "custom",
    customType: SESSION_FALLBACK_ENTRY_TYPE,
    data: { version: 1, event: "activated", at: "2026-01-01T00:00:00.000Z", models: {}, activation: null, ...entry } satisfies SessionFallbackEntry,
  };
}

it("activates the session's profile, whatever model `open()` happened to see", () => {
  const { controller, entries } = harness(A);
  controller.activateIfUnset();
  expect(controller.summary()).toMatchObject({ profileId: BALANCED.id, profileName: "Balanced", position: 0, models: [A, B] });
  // A provisional activation is what the next open would resolve again, so it
  // is not worth a line in the session file.
  expect(entries).toEqual([]);
});

it("follows the model the accepted first turn is actually on, inside the same profile", () => {
  // `open()` prepared the profile's first model; the accepted first turn put
  // the session on the second one. The profile is unchanged; the position
  // follows the model that is actually answering.
  const { controller, entries, select } = harness(A);
  controller.activateIfUnset();
  select(B);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toMatchObject({ profileId: BALANCED.id, position: 1, models: [A, B] });
  expect(entries).toEqual([]);
});

it("leaves a traversal that has already moved alone", () => {
  // A session that moved to B and was reloaded stands on B at position 1.
  // Re-resolving from the selected model would silently restart the profile.
  const { controller } = harness(B);
  controller.restore([savedEntry({ activation: { id: "saved", profileId: BALANCED.id, startedAt: "2026-01-01T00:00:00.000Z", models: [A, B], position: 1 } })]);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toMatchObject({ position: 1, models: [A, B] });
});

it("leaves a move in flight alone", () => {
  const { controller } = harness(C);
  controller.restore([savedEntry({
    activation: { id: "saved", profileId: BALANCED.id, startedAt: "2026-01-01T00:00:00.000Z", models: [A, B], position: 0 },
    failover: { id: "event", startedAt: "2026-01-01T00:00:00.000Z", attempts: [] },
  })]);
  controller.activateForAcceptedSelection();
  expect(controller.summary()).toMatchObject({ position: 0, models: [A, B] });
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

it("gives a session with no profile no activation at all", () => {
  // A pinned session, and a conversation older than profiles: both have a
  // model and nothing standing in for it.
  const { controller } = harness(A, null);
  controller.activateIfUnset();
  expect(controller.summary()).toBeUndefined();
  expect(controller.activeProfileId()).toBeNull();
});

it("a pin leaves no profile behind it, and says so once", () => {
  const { controller, entries } = harness(A);
  controller.activateIfUnset();
  expect(controller.activeProfileId()).toBe(BALANCED.id);

  controller.onPin(C);
  expect(controller.summary()).toBeUndefined();
  expect(controller.activeProfileId()).toBeNull();
  expect(entries.map((entry) => entry.event)).toEqual(["cleared"]);
  expect(entries[0]!.activation).toBeNull();
  expect(entries[0]!.to).toEqual(C);
});

it("choosing a profile re-anchors the session to it, with its list as it is now", () => {
  const { controller, entries, setProfile } = harness(A);
  controller.activateIfUnset();
  setProfile(OTHER);
  const activation = controller.onProfileChosen(OTHER);
  expect(activation).toMatchObject({ profileId: OTHER.id, position: 0, models: [C] });
  expect(controller.summary()).toMatchObject({ profileId: OTHER.id, profileName: "Local models", models: [C] });
  expect(entries.map((entry) => entry.event)).toEqual(["activated"]);
  expect(entries[0]!.to).toEqual(C);
});

it("never re-activates a traversal written before profiles existed", () => {
  // The record still reads — the conversation's history renders — but the
  // session has no profile and displays as pinned.
  const { controller } = harness(B);
  controller.restore([savedEntry({
    activation: { id: "old", chainKey: "stub/a", startedAt: "2026-01-01T00:00:00.000Z", models: [A, B], position: 1 },
  } as unknown as Partial<SessionFallbackEntry>)]);
  expect(controller.summary()).toBeUndefined();
  expect(controller.activeProfileId()).toBeNull();
});

it("starts on the first model it can use, records every skip, and says so once", async () => {
  // The profile prefers A, but this machine has no credential for it. The
  // session starts on B, the skip is in the session's own file, and one
  // update tells the person why they are not on the model they chose.
  const { controller, entries, updates } = harness(A);
  controller.activateIfUnset();
  const moved = await controller.startWalk();
  expect(moved).toEqual(B);
  expect(controller.summary()).toMatchObject({ profileId: BALANCED.id, position: 1 });
  expect(entries.map((entry) => entry.event)).toEqual(["activated"]);
  expect(entries[0]!.failover?.attempts).toEqual([
    { model: "stub/a", at: expect.any(String), outcome: "skipped", reason: "not signed in" },
  ]);
  const notice = updates.find((update) => update.kind === "model_fallback");
  expect(notice).toMatchObject({ phase: "switched", position: 1, profileId: BALANCED.id });
  expect((notice as { detail?: string }).detail).toContain("not signed in");
  expect(JSON.stringify(updates)).not.toContain("chain");
});

it("does not disturb a running conversation when the profile is edited", async () => {
  // The snapshot is taken at activation and never re-read: a saved edit
  // applies at the next activation (docs/model-profiles.md, "Runtime").
  const { controller, setProfile } = harness(A);
  controller.activateIfUnset();
  expect(controller.summary()).toMatchObject({ models: [A, B] });

  setProfile({ ...BALANCED, models: [C], updatedAt: "2026-02-02T00:00:00.000Z" });
  expect(controller.summary()).toMatchObject({ models: [A, B] });
  expect(controller.activeProfileId()).toBe(BALANCED.id);

  // The next activation is where the edit lands.
  const activation = controller.onProfileChosen({ ...BALANCED, models: [C] });
  expect(activation).toMatchObject({ models: [C] });
});
