/**
 * The two pieces of M4-T7 and the `@` popover with real logic in them:
 * the read-modify-write of the agent's own `keybindings.json`, and the
 * subsequence ranking behind `pi/project/files`.
 *
 * The keybindings tests run against the pinned agent for real — that is the
 * point. If a future Pi moves `KeybindingsManager`, renames an action or
 * changes a default, this fails here rather than in a person's Settings screen.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsAdapter, KeybindingsError } from "../src/keybindings.js";
import { scoreMatch } from "../src/files.js";

const dirs: string[] = [];
const agentDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-keys-`));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("KeybindingsAdapter", () => {
  it("reads the pinned agent's own actions, with its defaults in force", async () => {
    const dir = agentDir();
    const snapshot = await new KeybindingsAdapter({ agentDir: dir }).snapshot();

    expect(snapshot.path).toBe(join(dir, "keybindings.json"));
    expect(snapshot.writable).toBe(true);
    expect(snapshot.bindings.length).toBeGreaterThan(50);
    // Both halves are present: the agent's own actions and its editor keys.
    expect(snapshot.bindings.some((b) => b.section === "app")).toBe(true);
    expect(snapshot.bindings.some((b) => b.section === "tui")).toBe(true);

    const interrupt = snapshot.bindings.find((b) => b.id === "app.interrupt");
    expect(interrupt).toBeDefined();
    expect(interrupt?.description).toBeTruthy();
    expect(interrupt?.overridden).toBe(false);
    // Nothing overridden yet, so what is in force is exactly the default.
    expect(interrupt?.keys).toEqual(interrupt?.defaultKeys);
    expect(interrupt?.keys.length).toBeGreaterThan(0);
  });

  it("writes an override, reports it, and resets back to the default", async () => {
    const dir = agentDir();
    const adapter = new KeybindingsAdapter({ agentDir: dir });
    const file = join(dir, "keybindings.json");
    const before = (await adapter.snapshot()).bindings.find((b) => b.id === "app.session.new");

    const set = await adapter.apply([{ id: "app.session.new", op: "set", keys: ["ctrl+shift+n"] }]);
    const bound = set.bindings.find((b) => b.id === "app.session.new");
    expect(bound?.keys).toEqual(["ctrl+shift+n"]);
    expect(bound?.overridden).toBe(true);
    expect(bound?.defaultKeys).toEqual(before?.defaultKeys);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "app.session.new": "ctrl+shift+n" });

    const reset = await adapter.apply([{ id: "app.session.new", op: "reset" }]);
    const back = reset.bindings.find((b) => b.id === "app.session.new");
    expect(back?.overridden).toBe(false);
    expect(back?.keys).toEqual(before?.keys);
    // Reset removes the key rather than writing the default back, so a later
    // agent that changes its own default still reaches the person.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("keeps every other line of the file, and writes two keys as a list", async () => {
    const dir = agentDir();
    writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.clear": "ctrl+l" }, null, 2));
    const adapter = new KeybindingsAdapter({ agentDir: dir });
    await adapter.apply([{ id: "app.exit", op: "set", keys: ["ctrl+q", "ctrl+d"] }]);
    expect(JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf8"))).toEqual({
      "app.clear": "ctrl+l",
      "app.exit": ["ctrl+q", "ctrl+d"],
    });
  });

  it("refuses an action the pinned agent does not have, and changes nothing", async () => {
    const dir = agentDir();
    const adapter = new KeybindingsAdapter({ agentDir: dir });
    await expect(adapter.apply([{ id: "app.notAThing", op: "set", keys: ["ctrl+j"] }])).rejects.toBeInstanceOf(
      KeybindingsError,
    );
    // A batch is all-or-nothing: the valid half must not have landed either.
    await expect(
      adapter.apply([
        { id: "app.clear", op: "set", keys: ["ctrl+l"] },
        { id: "app.notAThing", op: "reset" },
      ]),
    ).rejects.toBeInstanceOf(KeybindingsError);
    expect(() => readFileSync(join(dir, "keybindings.json"), "utf8")).toThrow();
  });

  it("will not overwrite a file it cannot read, and says so", async () => {
    const dir = agentDir();
    writeFileSync(join(dir, "keybindings.json"), "{ not json");
    const adapter = new KeybindingsAdapter({ agentDir: dir });

    const snapshot = await adapter.snapshot();
    expect(snapshot.writable).toBe(false);
    expect(snapshot.reason).toContain("not valid JSON");

    await expect(adapter.apply([{ id: "app.clear", op: "set", keys: ["ctrl+l"] }])).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, "keybindings.json"), "utf8")).toBe("{ not json");
  });
});

describe("project file ranking", () => {
  it("matches a subsequence and puts the obvious answer first", () => {
    const paths = [
      "packages/ui/src/runtime/index.ts",
      "packages/ui/src/index.ts",
      "docs/architecture.md",
      "src/index.test.ts",
    ];
    const ranked = paths
      .map((path) => ({ path, score: scoreMatch(path, "srcindex") }))
      .filter((entry): entry is { path: string; score: number } => entry.score !== undefined)
      .sort((a, b) => b.score - a.score);

    expect(ranked.map((r) => r.path)).toContain("src/index.test.ts");
    expect(ranked[0]?.path).toBe("src/index.test.ts");
    expect(ranked.some((r) => r.path === "docs/architecture.md")).toBe(false);
  });

  it("is case-insensitive and rejects a query whose letters are out of order", () => {
    expect(scoreMatch("packages/UI/Shell.tsx", "uishell")).toBeDefined();
    expect(scoreMatch("src/index.ts", "xedni")).toBeUndefined();
    expect(scoreMatch("src/index.ts", "")).toBe(0);
  });
});
