import { afterEach, expect, it } from "vitest";
import {
  closeChanges,
  dismissFallbackNotice,
  openChanges,
  peekChangesUi,
  resetChangesUi,
  setRepoFilter,
  setUnifiedFallback,
} from "../../src/source-control/store.js";

afterEach(() => {
  resetChangesUi();
});

it("selects a file without filtering the overlay to its repository", () => {
  openChanges({ scope: { kind: "session" }, repo: "app", path: "src/a.ts" });
  expect(peekChangesUi().repoFilter).toBeNull();
  expect(peekChangesUi().active).toEqual({ repo: "app", path: "src/a.ts" });
  openChanges({ scope: { kind: "session" }, repo: "connecting", path: "lib/client.ts" });
  expect(peekChangesUi().repoFilter).toBeNull();
  expect(peekChangesUi().active).toEqual({ repo: "connecting", path: "lib/client.ts" });
  setRepoFilter("app");
  openChanges({ scope: { kind: "session" }, repo: "connecting", path: "lib/client.ts" });
  expect(peekChangesUi().repoFilter).toBe("app");
});

it("says the unified fallback once and lets the person dismiss it", () => {
  openChanges({ scope: { kind: "session" } });
  setUnifiedFallback(true);
  expect(peekChangesUi().unifiedFallback).toBe(true);
  expect(peekChangesUi().fallbackSaid).toBe(false);
  dismissFallbackNotice();
  expect(peekChangesUi().fallbackSaid).toBe(true);
  closeChanges();
  expect(peekChangesUi().fallbackSaid).toBe(false);
  expect(peekChangesUi().unifiedFallback).toBe(false);
});
