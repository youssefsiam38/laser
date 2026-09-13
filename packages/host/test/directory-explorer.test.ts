import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browseExplorer } from "../src/directory-explorer.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "directory-explorer-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const list = (path = root, prefix = "", offset = 0, limit = 80) => browseExplorer(path, { mode: "explorer", root, prefix, offset, limit });
it("sorts immediate children before paging: directories, files, then hidden", async () => {
  for (const name of ["z-folder", "a-folder", ".hidden-folder"]) mkdirSync(join(root, name));
  for (const name of ["z.txt", "a.txt", ".hidden-file"]) writeFileSync(join(root, name), "");
  const first = await list(root, "", 0, 2);
  expect(first.entries.map((entry) => [entry.name, entry.kind])).toEqual([["a-folder", "directory"], ["z-folder", "directory"]]);
  expect(first.nextOffset).toBe(2);
  const second = await list(root, "", first.nextOffset!, 2);
  expect(second.entries.map((entry) => entry.name)).toEqual(["a.txt", "z.txt"]);
  const last = await list(root, "", second.nextOffset!, 2);
  expect(last.entries.map((entry) => entry.name)).toEqual([".hidden-folder", ".hidden-file"]);
  expect(last.truncated).toBe(false); expect(last.nextOffset).toBeUndefined();
});
it("filters before pagination and computes completion across every match", async () => {
  for (let i = 0; i < 550; i++) writeFileSync(join(root, `file-${i}`), "");
  for (const name of ["node-a", "node-b", "node-z"]) mkdirSync(join(root, name));
  const page = await list(root, "node", 0, 2);
  expect(page.entries.map((entry) => entry.name)).toEqual(["node-a", "node-b"]);
  expect(page.commonPrefix).toBe("node-");
  expect((await list(root, "node", page.nextOffset!, 2)).entries[0]?.name).toBe("node-z");
  expect((await list(root, "", 0, 1000)).entries).toHaveLength(100);
});
it("uses git ignores, includes hidden/tracked files, and excludes escaping symlinks", async () => {
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "ignored\ntracked.txt\n");
  writeFileSync(join(root, "tracked.txt"), "");
  execFileSync("git", ["-C", root, "add", "-f", "tracked.txt"]);
  mkdirSync(join(root, "ignored")); mkdirSync(join(root, "server"));
  symlinkSync(join(root, "server"), join(root, "local-link"));
  symlinkSync(tmpdir(), join(root, "outside-link"));
  expect((await list()).entries.map((entry) => entry.name)).toEqual(["local-link", "server", "tracked.txt", ".gitignore"]);
  expect((await list(join(root, "outside-link"))).error).toBe("Choose a path inside this project.");
  expect((await list(join(root, ".."))).error).toBe("Choose a path inside this project.");
  expect((await list(join(root, "local-link"))).error).toBeUndefined();
});
it("explains missing/read failures and returns no entries", async () => {
  expect(await list(join(root, "gone"))).toMatchObject({ entries: [], truncated: false, error: "This folder no longer exists. Check the path." });
});
