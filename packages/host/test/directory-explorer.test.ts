import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browseExplorer } from "../src/directory-explorer.js";

let base: string, root: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "directory-explorer-")); root = join(base, "home", "project"); mkdirSync(root, { recursive: true }); });
afterEach(() => rmSync(base, { recursive: true, force: true }));
const list = (path = root, prefix = "", offset = 0, limit = 80) => browseExplorer(path, { mode: "explorer", cwd: root, prefix, offset, limit });
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
it('keeps global stable ordering across native-sort chunks and merge boundaries, with complete prefix and reachable tail', async () => {
  const names = Array.from({ length: 2051 }, (_, i) => `file-${(i * 7919) % 2051}`);
  for (const name of names) writeFileSync(join(root, name), '');
  const expected = [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || a.localeCompare(b, 'en'));
  for (const offset of [0, 500, 1010, 2030]) {
    const page = await list(root, 'FILE-', offset, 30);
    expect(page.entries.map(entry => entry.name)).toEqual(expected.slice(offset, offset + 30));
    expect(page.commonPrefix).toBe('file-');
    expect(page.nextOffset).toBe(offset + 30 < names.length ? offset + 30 : undefined);
  }
  const pages = await Promise.all([list(root, 'file-', 0, 30), list(root, 'FILE-', 30, 30), list(root, 'file-', 0, 30)]);
  expect(pages[0]).toEqual(pages[2]);
  expect(pages[1]?.entries.map(entry => entry.name)).toEqual(expected.slice(30, 60));
});

it("includes git-ignored, generated and dot entries without recursive traversal", async () => {
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n.hidden/\n");
  for (const name of ["node_modules", "dist", ".hidden"]) {
    mkdirSync(join(root, name)); writeFileSync(join(root, name, "nested.txt"), "not read by the listing");
  }
  expect((await list()).entries.map((entry) => entry.name)).toEqual(["dist", "node_modules", ".git", ".hidden", ".gitignore"]);
  expect((await list(root, "node")).entries.map((entry) => entry.name)).toEqual(["node_modules"]);
  expect((await list("node_modules")).entries.map((entry) => entry.name)).toEqual(["nested.txt"]);
});
it("lists parent, sibling, absolute paths and outside symlinks with OS-account authority", async () => {
  const sibling = join(base, "home", "sibling"); mkdirSync(sibling);
  writeFileSync(join(sibling, "guide.md"), "safe fixture");
  symlinkSync(sibling, join(root, "outside-link"));
  symlinkSync(join(sibling, "guide.md"), join(root, "outside-file"));
  symlinkSync(join(sibling, "missing"), join(root, "broken"));
  expect((await list("..")).entries.map((entry) => entry.name)).toEqual(["project", "sibling"]);
  for (const path of ["../sibling", sibling, "outside-link"]) {
    expect((await list(path)).entries.map((entry) => entry.name)).toEqual(["guide.md"]);
  }
  expect((await list()).entries.map((entry) => [entry.name, entry.kind])).toEqual([["outside-link", "directory"], ["outside-file", "file"]]);
  const filesystemRoot = await list(parse(root).root);
  expect(filesystemRoot.path).toBe(parse(root).root);
  expect(filesystemRoot.parent).toBeUndefined();
  expect(filesystemRoot.entries.length).toBeLessThanOrEqual(80);
});
it.skipIf(process.platform === "win32")("omits special files and symlinks to them without reading them", async () => {
  execFileSync("mkfifo", [join(root, "pipe")]);
  symlinkSync(join(root, "pipe"), join(root, "pipe-link"));
  expect((await list()).entries).toEqual([]);
});
it("explains missing/read failures and returns no entries", async () => {
  expect(await list(join(root, "gone"))).toMatchObject({ entries: [], truncated: false, error: "This folder no longer exists. Check the path." });
});
