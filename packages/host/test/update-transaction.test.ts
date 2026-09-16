import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UpdateTransactionStore } from "../src/update-transaction.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("durably correlates every activation phase by one update id", () => {
  const root = mkdtempSync(join(tmpdir(), "update-transaction-")); roots.push(root);
  const store = new UpdateTransactionStore(root, () => new Date("2026-09-16T00:00:00.000Z"));
  const updateId = "a".repeat(64);
  const targetGenerationId = "b".repeat(64);
  const previousGenerationId = "c".repeat(64);
  expect(store.begin({
    updateId,
    targetGenerationId,
    previousGenerationId,
    targetVersion: "1.2.3",
    buildIdentity: "build-123",
    manifestDigest: "d".repeat(64),
  })).toMatchObject({ phase: "discovered", updateId, targetGenerationId, previousGenerationId });
  for (const phase of ["staging", "staged", "parking", "ready", "selected", "restarting"] as const) {
    expect(store.transition(updateId, phase).phase).toBe(phase);
  }
  const succeeded = store.transition(updateId, "succeeded", {
    selectedLaunchId: "e".repeat(32),
    selectedVersion: "1.2.3",
  });
  expect(succeeded).toMatchObject({ phase: "succeeded", selectedLaunchId: "e".repeat(32), selectedVersion: "1.2.3" });
  const path = join(root, "update-transactions", `${updateId}.json`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).not.toContain("/private/");
});

it("refuses a mismatched reuse and an out-of-order success", () => {
  const root = mkdtempSync(join(tmpdir(), "update-transaction-")); roots.push(root);
  const store = new UpdateTransactionStore(root);
  const input = {
    updateId: "a".repeat(64), targetGenerationId: "b".repeat(64), previousGenerationId: "c".repeat(64),
    targetVersion: "1.2.3", buildIdentity: "build-123", manifestDigest: "d".repeat(64),
  };
  store.begin(input);
  expect(() => store.begin({ ...input, targetGenerationId: "e".repeat(64) })).toThrow();
  expect(() => store.transition(input.updateId, "succeeded")).toThrow();
});
