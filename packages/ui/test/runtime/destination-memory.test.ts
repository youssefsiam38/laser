// @vitest-environment happy-dom
/**
 * One shape in the destination memory (M16-T47 · review #48), inside one
 * environment (M18-T13 B).
 *
 * `main-destination-controller.ts` is the only writer of the destination
 * memory, and what it writes is `DestinationMemory`. It is read through
 * `deviceStore`, so before an environment is known there is nothing to read at
 * all — and the pre-environment keys are not a migration source: they recorded
 * projects and sessions without recording which environment they came from
 * (docs/environment-policy.md §7).
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { storageKey } from "@lasercode/protocol";

import { readDestinationMemory, initialDestinationFromMemory } from "../../src/runtime/main-destination-controller.js";
import { SESSIONS_TAB_STORAGE_KEY } from "../../src/runtime/session-tab-memory.js";
import { DEVICE_KEYS, deviceStore } from "../../src/runtime/device-storage.js";
import { activateTestEnvironment, deviceKeyName, seedDestination, seedFingerprint } from "./environment-fixture.js";

beforeEach(() => {
  localStorage.clear();
  deviceStore.deactivate();
});
afterEach(() => deviceStore.deactivate());

it("reads its own shape back, tab and code destination intact", () => {
  activateTestEnvironment();
  const code = { kind: "project-session", project: "/one", path: "/one/root.jsonl" } as const;
  seedDestination({ tab: "code", chat: "/state/chat/c1.jsonl", code });
  expect(readDestinationMemory()).toEqual({ v: 2, tab: "code", chat: "/state/chat/c1.jsonl", code });
  expect(initialDestinationFromMemory()).toMatchObject({ phase: "resolving", target: { kind: "code-tab", code } });
});

it("remembers nothing until an environment is established", () => {
  // The value is right there in storage, under this environment's name, beside
  // the record of the environment that wrote it, and it is still unreadable:
  // the descriptor has not landed, so the app does not know whose sessions
  // these are.
  seedDestination({ tab: "code", code: { kind: "project-session", project: "/one", path: "/one/root.jsonl" } });
  expect(readDestinationMemory()).toMatchObject({ v: 2, tab: "code", code: { kind: "no-project-landing" } });
  activateTestEnvironment();
  expect(readDestinationMemory()).toMatchObject({ code: { kind: "project-session", project: "/one" } });
});

it("does not adopt the pre-environment keys, however tempting they look", () => {
  const legacy = ["project", "session", "session-tab-last"].map((suffix) => storageKey(suffix));
  localStorage.setItem(legacy[0]!, "/one");
  localStorage.setItem(legacy[1]!, JSON.stringify({ "/one": "/one/root.jsonl" }));
  localStorage.setItem(legacy[2]!, JSON.stringify({ chat: "/state/chat/c2.jsonl", code: "/two/plain.jsonl" }));
  activateTestEnvironment();
  expect(readDestinationMemory()).toMatchObject({ v: 2, code: { kind: "no-project-landing" } });
  // And they are gone, rather than waiting for the next environment to claim.
  for (const key of legacy) expect(localStorage.getItem(key), key).toBeNull();
});

it("keeps the tab preference unscoped: an enum is not a place", () => {
  localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
  activateTestEnvironment();
  expect(readDestinationMemory()).toMatchObject({ tab: "chat", code: { kind: "no-project-landing" } });
  expect(localStorage.getItem(SESSIONS_TAB_STORAGE_KEY)).toBe("chat");
});

it("ignores a value of any other shape rather than throwing", () => {
  seedFingerprint();
  activateTestEnvironment();
  for (const stored of ["not json", "[]", "null", JSON.stringify({ v: 2, tab: "code" }), JSON.stringify({ v: 2, code: { kind: "nonsense" } })]) {
    localStorage.setItem(deviceKeyName(DEVICE_KEYS.destination), stored);
    expect(readDestinationMemory()).toMatchObject({ v: 2, code: { kind: "no-project-landing" } });
  }
});
