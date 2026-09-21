/**
 * What a capture believes about a file's bytes (M21-T18 review F9).
 *
 * `fileAt` is the one place the host turns a git blob into something it
 * stores as evidence, so it is the one place where "this is text" has to be
 * established rather than assumed. Everything here runs against a real git
 * repository: the bytes a file has are the bytes git gives back, and that is
 * the whole point of the check.
 *
 * Two files matter and they look identical to any test made after a lossy
 * decode: one whose bytes are an invalid UTF-8 sequence, and one that
 * genuinely contains U+FFFD. The first is not text; the second is ordinary
 * text that happens to include the replacement character, and refusing it
 * would throw away valid source.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";

import { fileAt, treeListing, treeManifest, workspaceRepositories, type HostRepository } from "../../src/source-control/read.js";

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
  };
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env }).toString();
}

/** A repository whose files are written as exact bytes, not as strings. */
async function repoWith(files: Record<string, Buffer>): Promise<{ repo: HostRepository; commit: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-read-`));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@x"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const [repo] = await workspaceRepositories(dir, { rescan: true });
  if (!repo) throw new Error("no repository");
  return { repo, commit: git(dir, ["rev-parse", "HEAD"]).trim(), dir };
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

const LIMIT = 128 * 1024;

describe.skipIf(!haveGit)("one bounded listing of a tree", () => {
  it("lists a scope by asking git for it, not by filtering a whole-tree listing", async () => {
    const files: Record<string, Buffer> = {};
    // Everything under `pad/` sorts before `src/`, and there is more of it
    // than the bound: a listing taken whole and filtered afterwards would find
    // nothing in the scope at all (review F1).
    for (let i = 0; i < 20; i++) files[`pad/${String(i).padStart(3, "0")}.ts`] = text(`pad ${String(i)}\n`);
    files["src/a.ts"] = text("a\n");
    files["src/deep/b.ts"] = text("b\n");
    const { repo, commit } = await repoWith(files);

    const whole = await treeListing(repo, commit, 10);
    expect(whole?.rows.length, "bounded, and it says so").toBe(10);
    expect(whole?.truncated).toBe(true);
    expect(whole?.rows.every((row) => row.path.startsWith("pad/"))).toBe(true);

    const scoped = await treeListing(repo, commit, 10, "src");
    expect(scoped?.truncated, "the scope itself fits").toBe(false);
    expect(scoped?.rows.map((row) => row.path)).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(scoped?.rows[0]?.blobObjectId).toMatch(/^[0-9a-f]{7,64}$/);
    expect(scoped?.rows[0]?.bytes).toBe(2);

    const oneFile = await treeListing(repo, commit, 10, "src/a.ts");
    expect(oneFile?.rows.map((row) => row.path)).toEqual(["src/a.ts"]);

    const absent = await treeListing(repo, commit, 10, "docs");
    expect(absent?.rows, "an empty answer, and not a failure").toEqual([]);
    expect(absent?.unreadable).toEqual([]);

    // `treeManifest` is the same listing with no scope, in the shape its
    // callers read.
    expect((await treeManifest(repo, commit, 10))?.length).toBe(10);
  });

  it("takes a scope literally, so a path with glob characters is a path", async () => {
    const { repo, commit } = await repoWith({
      "we[i]rd/one.ts": text("one\n"),
      "weird/two.ts": text("two\n"),
    });

    const scoped = await treeListing(repo, commit, 10, "we[i]rd");

    expect(scoped?.rows.map((row) => row.path), "the directory that is really called that").toEqual(["we[i]rd/one.ts"]);
  });

  it("names a gitlink instead of dropping it out of a listing that claims to be complete", async () => {
    const { repo, commit, dir } = await repoWith({ "src/a.ts": text("a\n") });
    // An ordinary nested repository, recorded as a gitlink: its contents are
    // not in this tree, and a listing that silently skipped it would describe
    // a scope it never read.
    const nested = join(dir, "vendor/widget");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-q", "-b", "main"]);
    git(nested, ["config", "user.email", "t@x"]);
    git(nested, ["config", "user.name", "t"]);
    git(nested, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(nested, "index.ts"), text("someone else's code\n"));
    git(nested, ["add", "-A"]);
    git(nested, ["commit", "-q", "-m", "nested"]);
    git(dir, ["config", "advice.addEmbeddedRepo", "false"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "vendor it"]);
    const withLink = git(dir, ["rev-parse", "HEAD"]).trim();
    expect(withLink).not.toBe(commit);

    const scoped = await treeListing(repo, withLink, 10, "vendor");

    expect(scoped?.rows, "there is nothing readable in that scope").toEqual([]);
    expect(scoped?.unreadable).toEqual([{ path: "vendor/widget", kind: "gitlink" }]);
    expect((await treeListing(repo, withLink, 10))?.unreadable, "and the whole-tree listing says so too").toEqual([
      { path: "vendor/widget", kind: "gitlink" },
    ]);
  });

  it("answers nothing at all when git cannot list, which is not an empty tree", async () => {
    const { repo } = await repoWith({ "src/a.ts": text("a\n") });
    expect(await treeListing(repo, "f".repeat(40), 10), "a commit this repository does not have").toBeUndefined();
    expect(await treeListing(repo, "not-an-object-id", 10)).toBeUndefined();
  });
});

describe.skipIf(!haveGit)("one file's bytes at one commit", () => {
  it("keeps valid text, including a file that really contains the replacement character", async () => {
    // `ef bf bd` is U+FFFD itself: valid UTF-8, and ordinary source as far as
    // anything here is concerned.
    const source = Buffer.from("const marker = \"\uFFFD\"; // caf\u00e9 \u2014 \u65e5\u672c\u8a9e\n", "utf8");
    const { repo, commit } = await repoWith({ "valid.ts": source });

    const read = await fileAt(repo, commit, "valid.ts", LIMIT);

    expect(read?.binary).toBe(false);
    expect(read?.bytes).toBe(source.byteLength);
    expect(read?.text).toBe(source.toString("utf8"));
    // What was stored re-encodes to exactly the file's bytes: nothing was lost.
    expect(Buffer.from(read?.text ?? "", "utf8").equals(source)).toBe(true);
  });

  it("refuses to call an invalid sequence text, even when a lossy decode would weigh the same", async () => {
    // `f0 90 80` is a truncated four-byte sequence. Decoded leniently it
    // becomes U+FFFD, which re-encodes to three bytes — the same count the
    // file has — so a byte-length comparison taken after the decode says
    // "text" about bytes that are not text and stores mojibake as evidence.
    const truncated = Buffer.from([0xf0, 0x90, 0x80]);
    expect(Buffer.from(truncated.toString("utf8"), "utf8").byteLength).toBe(truncated.byteLength);
    const { repo, commit } = await repoWith({ "broken.bin": truncated });

    const read = await fileAt(repo, commit, "broken.bin", LIMIT);

    expect(read?.binary).toBe(true);
    expect(read?.text).toBe("");
    // Identity and true size survive: that is what the record keeps.
    expect(read?.bytes).toBe(truncated.byteLength);
    expect(read?.blobObjectId).toMatch(/^[0-9a-f]{7,64}$/);
  });

  it("keeps a byte-order mark, which is a character of the file and not noise", async () => {
    // A decoder eats a leading BOM unless told not to, and a capture that ate
    // it would weigh less than git says the file does and digest differently
    // from the file's own bytes.
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const x = 1;\n", "utf8")]);
    const { repo, commit } = await repoWith({ "bom.ts": source });

    const read = await fileAt(repo, commit, "bom.ts", LIMIT);

    expect(read?.binary).toBe(false);
    expect(read?.bytes).toBe(source.byteLength);
    expect(read?.text.codePointAt(0)).toBe(0xfeff);
    expect(Buffer.from(read?.text ?? "", "utf8").equals(source)).toBe(true);
  });

  it("does not capture the bytes of a file with a NUL in it, and says what it weighs", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x41]);
    const { repo, commit } = await repoWith({ "image.png": binary });

    const read = await fileAt(repo, commit, "image.png", LIMIT);

    expect(read?.binary).toBe(true);
    expect(read?.text).toBe("");
    expect(read?.bytes).toBe(binary.byteLength);
  });

  it("cuts a long text file on a character boundary and says it is not whole", async () => {
    // Multi-byte characters across the cut: a naive slice would split one and
    // the stored text would end in a broken sequence.
    const source = Buffer.from("\u65e5".repeat(400), "utf8");
    const { repo, commit } = await repoWith({ "long.ts": source });

    const read = await fileAt(repo, commit, "long.ts", 101);

    expect(read?.binary).toBe(false);
    expect(read?.truncated).toBe(true);
    expect(read?.bytes).toBe(source.byteLength);
    const kept = Buffer.from(read?.text ?? "", "utf8");
    expect(kept.byteLength).toBeLessThanOrEqual(101);
    // Still whole characters, and still a prefix of the real file.
    expect(read?.text).toBe("\u65e5".repeat(33));
    expect(source.subarray(0, kept.byteLength).equals(kept)).toBe(true);
  });
});
