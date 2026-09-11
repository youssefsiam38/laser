import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-session-transaction-"));
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function durableManager(): { manager: SessionManager; path: string; baseline: Buffer } {
  const manager = SessionManager.create(root, root);
  manager.appendModelChange("stub", "before");
  manager.appendThinkingLevelChange("low");
  manager.appendCustomEntry("test/agent", { name: "before" });
  const path = manager.getSessionFile();
  expect(path).toBeDefined();
  manager.flush();
  return { manager, path: path!, baseline: readFileSync(path!) };
}

describe("pinned SessionManager durable append transaction", () => {
  it("flushes genuine empty state exclusively and idempotently", () => {
    const manager = SessionManager.create(root, root);
    manager.appendModelChange("stub", "one");
    manager.appendThinkingLevelChange("medium");
    const path = manager.getSessionFile()!;

    expect(existsSync(path)).toBe(false);
    manager.flush();
    const first = readFileSync(path);
    manager.flush();

    expect(readFileSync(path)).toEqual(first);
    expect(first.toString()).toContain('"type":"session"');
    expect(first.toString()).toContain('"type":"model_change"');
    expect(first.toString()).toContain('"type":"thinking_level_change"');
  });

  it("never overwrites a path that appeared before the exclusive first flush", () => {
    const manager = SessionManager.create(root, root);
    manager.appendThinkingLevelChange("low");
    const path = manager.getSessionFile()!;
    writeFileSync(path, "owned elsewhere\n");
    expect(() => manager.flush()).toThrow();
    expect(readFileSync(path, "utf8")).toBe("owned elsewhere\n");
  });

  it("rolls back an injected setup failure with entries, leaf, labels and bytes exact", () => {
    const { manager, path, baseline } = durableManager();
    const baselineEntries = manager.getEntries();
    const baselineLeaf = manager.getLeafId();
    const transaction = manager.beginAppendTransaction();
    let setupError: unknown;
    try {
      const labelled = manager.appendCustomEntry("test/setup", { candidate: true });
      manager.appendLabelChange(labelled, "candidate");
      manager.appendModelChange("stub", "candidate");
      throw new Error("injected setup failure");
    } catch (error) {
      setupError = error;
    }
    const labelled = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "test/setup")!.id;

    expect(readFileSync(path)).toEqual(baseline);
    expect(manager.getLabel(labelled)).toBe("candidate");
    expect(() => manager.beginAppendTransaction()).toThrow(/already active/);
    expect(() => manager.newSession()).toThrow(/transaction is active/);
    expect(() => manager.setSessionFile(path)).toThrow(/transaction is active/);
    const candidateLeaf = manager.getLeafId();
    expect(() => manager.branch(baselineLeaf!)).toThrow(/transaction is active/);
    expect(() => manager.branchWithSummary(baselineLeaf, "candidate", undefined, false)).toThrow(/transaction is active/);
    expect(manager.getLeafId()).toBe(candidateLeaf);
    expect(() => manager.resetLeaf()).toThrow(/transaction is active/);
    expect(() => manager.createBranchedSession(baselineLeaf!)).toThrow(/transaction is active/);

    expect(setupError).toMatchObject({ message: "injected setup failure" });
    transaction.rollback();
    expect(readFileSync(path)).toEqual(baseline);
    expect(manager.getEntries()).toEqual(baselineEntries);
    expect(manager.getLeafId()).toBe(baselineLeaf);
    expect(manager.getLabel(labelled)).toBeUndefined();
    expect(() => transaction.rollback()).toThrow(/no longer active/);
  });

  it("atomically commits the exact baseline plus accepted suffix once", () => {
    const { manager, path, baseline } = durableManager();
    chmodSync(path, 0o600);
    const baselineStat = statSync(path);
    const transaction = manager.beginAppendTransaction();
    manager.appendModelChange("stub", "accepted");
    manager.appendThinkingLevelChange("high");
    manager.appendCustomEntry("test/agent", { name: "accepted" });

    transaction.commit();
    const committed = readFileSync(path);
    expect(committed.subarray(0, baseline.length)).toEqual(baseline);
    expect(statSync(path)).toMatchObject({ uid: baselineStat.uid, gid: baselineStat.gid });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(committed.toString().match(/"modelId":"accepted"/g)).toHaveLength(1);
    expect(committed.toString().match(/"name":"accepted"/g)).toHaveLength(1);
    expect(() => transaction.commit()).toThrow(/no longer active/);
    expect(readdirSync(root).filter((name) => name.includes(".append-") || name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves baseline bytes intact on commit failure and retries the whole retained suffix once", () => {
    const { manager, path, baseline } = durableManager();
    chmodSync(path, 0o600);
    const baselineStat = statSync(path);
    const transaction = manager.beginAppendTransaction();
    manager.appendCustomEntry("test/accepted", { ordinal: 1 });
    chmodSync(root, 0o500);
    expect(() => transaction.commit()).toThrow();
    expect(readFileSync(path)).toEqual(baseline);

    chmodSync(root, 0o700);
    manager.appendCustomEntry("test/user", { ordinal: 2 });
    const committed = readFileSync(path);
    expect(committed.subarray(0, baseline.length)).toEqual(baseline);
    expect(statSync(path)).toMatchObject({ uid: baselineStat.uid, gid: baselineStat.gid });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(committed.toString().match(/"ordinal":1/g)).toHaveLength(1);
    expect(committed.toString().match(/"ordinal":2/g)).toHaveLength(1);
  });

  it("fails closed after the one retained-suffix retry also fails", () => {
    const { manager, path, baseline } = durableManager();
    const transaction = manager.beginAppendTransaction();
    manager.appendCustomEntry("test/accepted", { ordinal: 1 });
    chmodSync(root, 0o500);
    expect(() => transaction.commit()).toThrow();
    expect(() => manager.appendCustomEntry("test/user", { ordinal: 2 })).toThrow();
    expect(readFileSync(path)).toEqual(baseline);

    chmodSync(root, 0o700);
    expect(() => manager.appendCustomEntry("test/later", { ordinal: 3 })).toThrow(/could not be persisted/);
    expect(readFileSync(path)).toEqual(baseline);
  });

  it("removes its owned file after exclusive creation and a partial initial flush", () => {
    const manager = SessionManager.create(root, root);
    manager.appendModelChange("stub", "one");
    // The genuine header and model line are written first; JSON serialization
    // of this later entry then fails, after this process exclusively created
    // and partially populated the final path.
    manager.appendCustomEntry("test/unserializable", { value: 1n });
    const path = manager.getSessionFile()!;
    expect(() => manager.flush()).toThrow(/BigInt|serializ/);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".append-") || name.endsWith(".tmp"))).toEqual([]);
  });
});
