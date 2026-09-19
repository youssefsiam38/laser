/**
 * `pi/project/file_blob` against real git fixtures (M20-T5): a real PNG in a
 * real repository, added, modified and deleted, plus the two things the engine
 * refuses to send — a file that is not an image, and one over the ceiling.
 */
import { FILE_BLOB_MAX_BYTES, FILE_BLOB_PAGE_MAX_BYTES, PRODUCT_NAME, ProtocolError } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { SourceControlService } from "../src/source-control/index.js";

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SESSION = "/sessions/demo.jsonl";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env }).toString();
}

/** A real PNG: signature, IHDR, one deflated IDAT, IEND, every CRC correct. */
function png(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const flat = (r: number, g: number, b: number) => () => [r, g, b] as [number, number, number];

function repo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@x"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function service(cwd: string): SourceControlService {
  return new SourceControlService({
    projectCwd: cwd,
    sessionWorkdir: () => cwd,
    sessionStreaming: () => false,
    agentRun: () => undefined,
  });
}

const ask = (ctl: SourceControlService, dir: string, file: string, ref: string, offset = 0) =>
  ctl.fileBlob({ cwd: dir, path: SESSION, repo: dir, file, ref, offset });

describe.skipIf(!haveGit)("image bytes, per change kind", () => {
  it("serves an added image from the working tree, with its media type, size and header dimensions", async () => {
    const dir = temp("blob-add");
    repo(dir);
    const bytes = png(8, 4, flat(0, 128, 255));
    writeFileSync(join(dir, "logo.png"), bytes);
    const ctl = service(dir);

    const blob = await ask(ctl, dir, "logo.png", "worktree");
    expect(blob).toMatchObject({
      repo: dir,
      path: "logo.png",
      ref: "worktree",
      mediaType: "image/png",
      totalBytes: bytes.length,
      offset: 0,
      bytes: bytes.length,
      truncated: false,
      width: 8,
      height: 4,
    });
    expect(blob.next).toBeUndefined();
    expect(blob.refused).toBeUndefined();
    expect(Buffer.from(blob.data!, "base64").equals(bytes)).toBe(true);

    // The other end of an `added` file is not in HEAD, and the engine says so
    // rather than quietly answering with the working tree.
    await expect(ask(ctl, dir, "logo.png", "HEAD")).rejects.toBeInstanceOf(ProtocolError);
  });

  it("serves both sides of a modified image, each from its own end", async () => {
    const dir = temp("blob-mod");
    repo(dir);
    const before = png(8, 4, flat(255, 0, 0));
    writeFileSync(join(dir, "logo.png"), before);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "logo"]);
    const after = png(16, 9, flat(0, 0, 255));
    writeFileSync(join(dir, "logo.png"), after);
    const ctl = service(dir);

    const old = await ask(ctl, dir, "logo.png", "HEAD");
    expect(old).toMatchObject({ ref: "HEAD", totalBytes: before.length, width: 8, height: 4, truncated: false });
    expect(Buffer.from(old.data!, "base64").equals(before)).toBe(true);

    const next = await ask(ctl, dir, "logo.png", "worktree");
    expect(next).toMatchObject({ ref: "worktree", totalBytes: after.length, width: 16, height: 9 });
    expect(Buffer.from(next.data!, "base64").equals(after)).toBe(true);
    expect(next.totalBytes).not.toBe(old.totalBytes);
  });

  it("serves a deleted image from the revision it still exists in", async () => {
    const dir = temp("blob-del");
    repo(dir);
    const bytes = png(4, 4, flat(9, 9, 9));
    writeFileSync(join(dir, "logo.png"), bytes);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "logo"]);
    unlinkSync(join(dir, "logo.png"));
    const ctl = service(dir);

    const old = await ask(ctl, dir, "logo.png", "HEAD");
    expect(old.totalBytes).toBe(bytes.length);
    expect(Buffer.from(old.data!, "base64").equals(bytes)).toBe(true);
    // The working tree no longer has it, and that is an error, not an empty file.
    await expect(ask(ctl, dir, "logo.png", "worktree")).rejects.toBeInstanceOf(ProtocolError);
  });

  it("pages a large image and the pages rebuild it byte for byte", async () => {
    const dir = temp("blob-page");
    repo(dir);
    // Noise: deflate cannot shrink it, so the file is comfortably over a page.
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed;
    };
    const bytes = png(512, 512, () => [next() & 0xff, next() & 0xff, next() & 0xff]);
    expect(bytes.length).toBeGreaterThan(FILE_BLOB_PAGE_MAX_BYTES);
    writeFileSync(join(dir, "big.png"), bytes);
    const ctl = service(dir);

    const first = await ask(ctl, dir, "big.png", "worktree");
    expect(first.bytes).toBe(FILE_BLOB_PAGE_MAX_BYTES);
    expect(first.next).toBe(FILE_BLOB_PAGE_MAX_BYTES);
    expect(first.truncated).toBe(true);
    expect(first).toMatchObject({ width: 512, height: 512 });

    const pages = [Buffer.from(first.data!, "base64")];
    let at = first.next;
    while (at !== undefined) {
      const page = await ask(ctl, dir, "big.png", "worktree", at);
      expect(page.width).toBeUndefined();
      expect(page.height).toBeUndefined();
      pages.push(Buffer.from(page.data!, "base64"));
      at = page.next;
    }
    expect(Buffer.concat(pages).equals(bytes)).toBe(true);
  });
});

describe.skipIf(!haveGit)("what the engine will not send", () => {
  it("answers a file that is not an image with its size and no bytes", async () => {
    const dir = temp("blob-opaque");
    repo(dir);
    const archive = Buffer.alloc(2048, 7);
    writeFileSync(join(dir, "vendor.woff2"), archive);
    const ctl = service(dir);

    const blob = await ask(ctl, dir, "vendor.woff2", "worktree");
    expect(blob).toMatchObject({
      mediaType: "application/octet-stream",
      totalBytes: archive.length,
      bytes: 0,
      refused: "not-an-image",
    });
    expect(blob.data).toBeUndefined();
    // An SVG is text: it has a textual diff and is never served as bytes.
    writeFileSync(join(dir, "mark.svg"), "<svg/>\n");
    expect((await ask(ctl, dir, "mark.svg", "worktree")).refused).toBe("not-an-image");
  });

  it("refuses an image over the ceiling without reading it, and says how large it is", async () => {
    const dir = temp("blob-huge");
    repo(dir);
    const size = FILE_BLOB_MAX_BYTES + 1;
    writeFileSync(join(dir, "huge.png"), Buffer.alloc(size));
    const ctl = service(dir);

    const blob = await ask(ctl, dir, "huge.png", "worktree");
    expect(blob).toMatchObject({ mediaType: "image/png", totalBytes: size, bytes: 0, refused: "too-large" });
    expect(blob.data).toBeUndefined();
    expect(blob.width).toBeUndefined();
  });

  it("calls an empty image empty, and refuses a path outside the repository or a hostile ref", async () => {
    const dir = temp("blob-edge");
    repo(dir);
    writeFileSync(join(dir, "empty.png"), Buffer.alloc(0));
    const ctl = service(dir);

    expect(await ask(ctl, dir, "empty.png", "worktree")).toMatchObject({ totalBytes: 0, bytes: 0, refused: "empty", truncated: false });
    await expect(ask(ctl, dir, "../outside.png", "worktree")).rejects.toBeInstanceOf(ProtocolError);
    await expect(ask(ctl, dir, "logo.png", "--upload-pack=touch")).rejects.toBeInstanceOf(ProtocolError);
    await expect(ask(ctl, dir, "logo.png", "HEAD..main")).rejects.toBeInstanceOf(ProtocolError);
  });
});
