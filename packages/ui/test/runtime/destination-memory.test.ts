// @vitest-environment happy-dom
/**
 * One shape in the destination memory (M16-T47 · review #48).
 *
 * `main-destination-controller.ts` is the only writer of
 * `SESSION_TAB_MEMORY_KEY`, and what it writes is `DestinationMemory`. A second
 * pair of accessors used to write a flat `{ chat, code }` of session paths over
 * the same key; one call turned `code` into a string and the person came back
 * to a destination nobody chose. A flat value an older build left behind is
 * migrated, never read as memory.
 */
import { beforeEach, expect, it } from "vitest";

import { PROJECT_STORAGE_KEY, SESSION_STORAGE_KEY, readDestinationMemory, initialDestinationFromMemory } from "../../src/runtime/main-destination-controller.js";
import { SESSION_TAB_MEMORY_KEY, SESSIONS_TAB_STORAGE_KEY } from "../../src/runtime/session-tab-memory.js";

beforeEach(() => localStorage.clear());

it("reads its own shape back, tab and code destination intact", () => {
  const code = { kind: "project-session", project: "/one", path: "/one/root.jsonl" } as const;
  localStorage.setItem(SESSION_TAB_MEMORY_KEY, JSON.stringify({ v: 2, tab: "code", chat: "/state/chat/c1.jsonl", code }));
  expect(readDestinationMemory()).toEqual({ v: 2, tab: "code", chat: "/state/chat/c1.jsonl", code });
  expect(initialDestinationFromMemory()).toMatchObject({ phase: "resolving", target: { kind: "code-tab", code } });
});

it("migrates the pre-controller flat shape instead of trusting it", () => {
  // What the removed writer left behind: `code` is a session path, not a
  // destination, so the code half comes from the project/session keys.
  localStorage.setItem(SESSION_TAB_MEMORY_KEY, JSON.stringify({ chat: "/state/chat/c2.jsonl", code: "/two/plain.jsonl" }));
  localStorage.setItem(PROJECT_STORAGE_KEY, "/one");
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ "/one": "/one/root.jsonl" }));
  localStorage.setItem(SESSIONS_TAB_STORAGE_KEY, "chat");
  expect(readDestinationMemory()).toEqual({
    v: 2,
    tab: "chat",
    chat: "/state/chat/c2.jsonl",
    code: { kind: "project-session", project: "/one", path: "/one/root.jsonl" },
    legacy: true,
  });
});

it("ignores a value of any other shape rather than throwing", () => {
  for (const stored of ["not json", "[]", "null", JSON.stringify({ v: 2, tab: "code" }), JSON.stringify({ v: 2, code: { kind: "nonsense" } })]) {
    localStorage.setItem(SESSION_TAB_MEMORY_KEY, stored);
    expect(readDestinationMemory()).toMatchObject({ v: 2, code: { kind: "no-project-landing" }, legacy: true });
  }
});
