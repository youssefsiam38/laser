/**
 * GitService (M2-T6): the parsers, and the baseline semantics against a real
 * temporary repository — "since the session started" must count what the
 * session did, not what was already dirty when it opened.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GitService, countLines, parseAheadBehind, parseNumstat, parsePorcelain } from "../src/git.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

describe("bounded new-file admission", () => {
  it("skips sparse, binary, symlink and disappearing files and enforces an aggregate byte budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-git-bounds-`));
    const count = (service: GitService, paths: string[]) => (service as unknown as { linesOfNewFiles(p: string[]): Promise<number> }).linesOfNewFiles(paths);
    try {
      const fd = openSync(join(dir, "huge"), "w");
      ftruncateSync(fd, 2 * 1024 ** 3); closeSync(fd);
      writeFileSync(join(dir, "binary"), Buffer.alloc(32 * 1024));
      writeFileSync(join(dir, "small"), "a\nb");
      symlinkSync("small", join(dir, "link"));
      const spy = vi.spyOn(fs, "open");
      try {
        expect(await count(new GitService({ cwd: dir }), ["huge"])).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
      expect(await count(new GitService({ cwd: dir }), ["binary", "link", "gone", "small"])).toBe(2);
      // A producer cannot force an unbounded read by growing after admission.
      const original = fs.open;
      const grow = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const file = await original(...args);
        const stat = file.stat.bind(file);
        file.stat = async (...statArgs: Parameters<typeof file.stat>) => {
          const info = await stat(...statArgs);
          writeFileSync(join(dir, "small"), "x".repeat(1024 * 1024));
          return info;
        };
        return file;
      });
      try { expect(await count(new GitService({ cwd: dir, maxNewFileBytes: 100 }), ["small"])).toBe(0); }
      finally { grow.mockRestore(); }
      writeFileSync(join(dir, "a"), "a\n"); writeFileSync(join(dir, "b"), "b\n");
      expect(await count(new GitService({ cwd: dir, maxNewFilesTotalBytes: 3 }), ["a", "b"])).toBe(1);
      if (process.platform !== "win32") {
        execFileSync("mkfifo", [join(dir, "pipe")]);
        expect(await count(new GitService({ cwd: dir }), ["pipe"])).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("git parsers", () => {
  it("sums numstat and skips binaries", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n10\t0\tb.md\n")).toEqual({ added: 13, removed: 1, files: 3 });
    expect(parseNumstat("")).toEqual({ added: 0, removed: 0, files: 0 });
  });

  it("reads rev-list --left-right --count as behind then ahead", () => {
    expect(parseAheadBehind("2\t5\n")).toEqual({ behind: 2, ahead: 5 });
    expect(parseAheadBehind("")).toEqual({ behind: 0, ahead: 0 });
  });

  it("parses porcelain -z including renames with their second path", () => {
    const text = ["R  new.ts", "old.ts", "?? notes.md", " M src/x.ts", ""].join("\0");
    expect(parsePorcelain(text)).toEqual({ dirty: true, untracked: ["notes.md"] });
    expect(parsePorcelain("")).toEqual({ dirty: false, untracked: [] });
  });

  it("counts lines like wc -l plus an unterminated tail", () => {
    expect(countLines(new TextEncoder().encode("a\nb\n"))).toBe(2);
    expect(countLines(new TextEncoder().encode("a\nb"))).toBe(2);
    expect(countLines(new Uint8Array(0))).toBe(0);
  });
});

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveGit)("GitService against a repository", () => {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-git-`));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
    }).toString();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("counts only what happened after the baseline", async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    // Dirty before the session opens: this must not count.
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "pre.txt"), "already here\n");

    const service = new GitService({ cwd: dir, ttlMs: 0 });
    await service.baseline("/s/one.jsonl");
    const before = await service.status("/s/one.jsonl");
    expect(before).toMatchObject({ isRepo: true, branch: "main", added: 0, removed: 0, dirty: true, ahead: 0, behind: 0 });
    expect(before.upstream).toBeUndefined();

    // The session edits a tracked file and creates a new one.
    writeFileSync(join(dir, "a.txt"), "one\nthree\nfour\n"); // -two +four vs baseline
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\nexport const y = 2;\n");
    const after = await service.status("/s/one.jsonl");
    expect(after).toMatchObject({ added: 3, removed: 1, dirty: true });

    // A second session opened now starts from zero.
    await service.baseline("/s/two.jsonl");
    expect(await service.status("/s/two.jsonl")).toMatchObject({ added: 0, removed: 0 });
  });

  it("reports a directory that is not a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-plain-`));
    try {
      const service = new GitService({ cwd: plain, ttlMs: 0 });
      await service.baseline("/s/x.jsonl");
      expect(await service.status("/s/x.jsonl")).toMatchObject({ isRepo: false });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
