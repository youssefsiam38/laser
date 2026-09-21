/**
 * The interop filesystem boundary, over a mocked filesystem (M21-T21).
 *
 * Every import read and every export write goes through `export/paths.ts`, so
 * this is where "confined to the project the person chose" is proved. It is
 * proved against a *mocked* `node:fs`: the tests describe a link, a forbidden
 * area or a ceiling, and then assert both the refusal and that **nothing was
 * read, created, written or unlinked** — no traversal is performed, nothing
 * outside a fixture is touched, and there is no directory on this machine that
 * these tests could reach even if the boundary were broken.
 *
 * The positive paths (a real export, a real import, a real publication) are
 * the router tests in `interop.test.ts`, over ordinary temporary folders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Absolute paths that exist, as directories and as regular files. */
const directories = new Set<string>();
const files = new Map<string, string>();
/** Symlinks: the path, and where it points. */
const links = new Map<string, string>();
/** Descriptors handed out by the fake `openSync`, and what they opened. */
const open = new Map<number, string>();
let nextDescriptor = 3;

class FakeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Resolve every link prefix of a path, as `realpath` does. */
function realOf(path: string): string {
  let current = path;
  for (let round = 0; round < 16; round += 1) {
    let changed = false;
    for (const [from, to] of links) {
      if (current === from || current.startsWith(`${from}/`)) {
        current = `${to}${current.slice(from.length)}`;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

function statOf(path: string): { isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean; size: number } {
  if (links.has(path)) return kind("link", 0);
  if (directories.has(path)) return kind("directory", 0);
  const contents = files.get(path);
  if (contents !== undefined) return kind("file", Buffer.byteLength(contents, "utf8"));
  throw new FakeError("ENOENT");
}

function kind(what: "link" | "directory" | "file", size: number) {
  return {
    isSymbolicLink: () => what === "link",
    isDirectory: () => what === "directory",
    isFile: () => what === "file",
    size,
  };
}

const fs = {
  lstatSync: vi.fn((path: string) => statOf(path)),
  realpathSync: vi.fn((path: string) => {
    const real = realOf(path);
    if (!directories.has(real) && !files.has(real)) throw new FakeError("ENOENT");
    return real;
  }),
  openSync: vi.fn((path: string, _flags: number) => {
    const real = realOf(path);
    if (links.has(path)) throw new FakeError("ELOOP");
    if (!files.has(real) && !directories.has(real)) throw new FakeError("ENOENT");
    const descriptor = nextDescriptor++;
    open.set(descriptor, real);
    return descriptor;
  }),
  fstatSync: vi.fn((descriptor: number) => statOf(open.get(descriptor)!)),
  readFileSync: vi.fn((descriptor: number) => files.get(open.get(descriptor)!) ?? ""),
  closeSync: vi.fn((descriptor: number) => {
    open.delete(descriptor);
  }),
  mkdirSync: vi.fn((path: string, _options?: unknown) => {
    const real = realOf(path);
    const parts = real.split("/").filter((part) => part !== "");
    let cursor = "";
    for (const part of parts) {
      cursor = `${cursor}/${part}`;
      directories.add(cursor);
    }
    return undefined;
  }),
  writeFileSync: vi.fn((path: string, contents: string, options?: { flag?: string }) => {
    const real = realOf(path);
    if (options?.flag === "wx" && (files.has(real) || links.has(path))) throw new FakeError("EEXIST");
    files.set(real, contents);
  }),
  renameSync: vi.fn((from: string, to: string) => {
    const contents = files.get(realOf(from));
    files.delete(realOf(from));
    // A rename replaces the name, link included: it never writes through one.
    links.delete(to);
    if (contents !== undefined) files.set(realOf(to), contents);
  }),
  rmSync: vi.fn((path: string) => {
    files.delete(realOf(path));
  }),
  unlinkSync: vi.fn((path: string) => {
    if (links.delete(path)) return;
    files.delete(realOf(path));
  }),
  readdirSync: vi.fn(() => []),
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
};

vi.mock("node:fs", () => fs);

const { insideProject, insideProjectAt, kindOf, readTextFile, removeFile, writeFileAtomic } = await import(
  "../../src/project-work/export/paths.js"
);
const { PROJECT_DIR_NAME, WORK_EXPORT_DIR } = await import("@lasercode/protocol");

const PROJECT = "/home/person/project";
const OUTSIDE = "/home/person/elsewhere";

/** Nothing reached the filesystem beyond looking at what a path is. */
function expectNoFilesystemEffect(): void {
  expect(fs.openSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(fs.unlinkSync).not.toHaveBeenCalled();
  expect(fs.rmSync).not.toHaveBeenCalled();
}

beforeEach(() => {
  directories.clear();
  files.clear();
  links.clear();
  open.clear();
  for (const directory of [
    "/",
    "/home",
    "/home/person",
    PROJECT,
    `${PROJECT}/docs`,
    `${PROJECT}/${PROJECT_DIR_NAME}`,
    `${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`,
    OUTSIDE,
    `${OUTSIDE}/secrets`,
  ]) {
    directories.add(directory);
  }
  files.set(`${OUTSIDE}/secrets/notes.md`, "someone else's file\n");
  files.set(`${PROJECT}/${PROJECT_DIR_NAME}/settings.json`, '{"kept":true}\n');
  for (const spy of Object.values(fs)) if (typeof spy === "function") (spy as ReturnType<typeof vi.fn>).mockClear();
});

describe("a path inside the project", () => {
  it("resolves an ordinary project-relative path", () => {
    expect(insideProject(PROJECT, "docs/spec.md")).toBe(`${PROJECT}/docs/spec.md`);
    expect(insideProject(PROJECT, `./${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`)).toBe(`${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`);
    expect(insideProjectAt(PROJECT, `${PROJECT}/docs`, "sub/one.md")).toBe(`${PROJECT}/docs/sub/one.md`);
  });

  it("allows a link that stays inside the project, because that is the person's own layout", () => {
    directories.add(`${PROJECT}/real-docs`);
    links.set(`${PROJECT}/linked-docs`, `${PROJECT}/real-docs`);
    expect(insideProjectAt(PROJECT, `${PROJECT}/linked-docs`, "one.md")).toBe(`${PROJECT}/linked-docs/one.md`);
  });

  it("refuses an absolute path, an empty one and one that climbs out", () => {
    for (const path of ["", "/etc/passwd", "../elsewhere/secrets", "docs/../../elsewhere"]) {
      expect(() => insideProject(PROJECT, path)).toThrow(/Name a folder inside this project/);
    }
    expectNoFilesystemEffect();
  });
});

describe("a link that leads out of the project", () => {
  it("refuses a root that is a link out, and reads or writes nothing", () => {
    links.set(`${PROJECT}/exported`, `${OUTSIDE}/secrets`);
    expect(() => insideProject(PROJECT, "exported")).toThrow("Name a folder inside this project.");
    expectNoFilesystemEffect();
  });

  it("refuses a path whose ancestor is a link out, and reads or writes nothing", () => {
    links.set(`${PROJECT}/exported`, `${OUTSIDE}/secrets`);
    expect(() => insideProject(PROJECT, "exported/notes.md")).toThrow(/Name a folder inside this project/);
    expect(() => insideProjectAt(PROJECT, `${PROJECT}/exported`, "notes.md")).toThrow(/Name a folder inside this project/);
    expectNoFilesystemEffect();
    // The file that link points at is exactly as it was.
    expect(files.get(`${OUTSIDE}/secrets/notes.md`)).toBe("someone else's file\n");
  });

  it("refuses the final component when it is a link, wherever it points", () => {
    files.set(`${PROJECT}/docs/real.md`, "mine\n");
    links.set(`${PROJECT}/docs/spec.md`, `${PROJECT}/docs/real.md`);
    expect(() => insideProject(PROJECT, "docs/spec.md")).toThrow(/leads out of this project through a link/);
    expectNoFilesystemEffect();
  });

  it("refuses a link that reaches the project's own settings from somewhere allowed", () => {
    links.set(`${PROJECT}/docs/config`, `${PROJECT}/${PROJECT_DIR_NAME}`);
    expect(() => insideProjectAt(PROJECT, `${PROJECT}/docs`, "config/settings.json")).toThrow(/this project's own settings/);
    expectNoFilesystemEffect();
    expect(files.get(`${PROJECT}/${PROJECT_DIR_NAME}/settings.json`)).toBe('{"kept":true}\n');
  });
});

describe("the areas no import reads and no export writes", () => {
  it("refuses a repository's own storage, at the root and below it", () => {
    for (const path of [".git", ".git/config", "packages/thing/.git/hooks"]) {
      expect(() => insideProject(PROJECT, path)).toThrow(/repository's own storage/);
    }
    expectNoFilesystemEffect();
  });

  it("refuses this project's settings folder, and allows only the export area inside it", () => {
    for (const path of [PROJECT_DIR_NAME, `${PROJECT_DIR_NAME}/settings.json`, `${PROJECT_DIR_NAME}/design/index.json`, `${PROJECT_DIR_NAME}/worktree-setup`]) {
      expect(() => insideProject(PROJECT, path)).toThrow(/this project's own settings/);
    }
    expectNoFilesystemEffect();
    expect(insideProject(PROJECT, `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`)).toBe(`${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`);
    expect(insideProject(PROJECT, `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}-2/SPEC-1.md`)).toBe(
      `${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}-2/SPEC-1.md`,
    );
  });
});

describe("the file operations themselves", () => {
  it("reads without following the last component, and refuses anything over the ceiling", () => {
    files.set(`${PROJECT}/docs/one.md`, "hello\n");
    expect(readTextFile(`${PROJECT}/docs/one.md`, 1024)).toBe("hello\n");
    expect(fs.openSync).toHaveBeenCalledWith(`${PROJECT}/docs/one.md`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    fs.readFileSync.mockClear();
    expect(readTextFile(`${PROJECT}/docs/one.md`, 2)).toBeUndefined();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    // A directory is not a document, and a link is refused by the open itself.
    expect(readTextFile(`${PROJECT}/docs`, 1024)).toBeUndefined();
    links.set(`${PROJECT}/docs/linked.md`, `${OUTSIDE}/secrets/notes.md`);
    expect(readTextFile(`${PROJECT}/docs/linked.md`, 1024)).toBeUndefined();
    // Every descriptor this opened was closed.
    expect(open.size).toBe(0);
  });

  it("writes through a fresh exclusive temporary file and renames it into place", () => {
    writeFileAtomic(`${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}/SPEC-1.md`, "# Spec\n", { within: PROJECT });
    const write = fs.writeFileSync.mock.calls[0]!;
    expect(String(write[0])).toMatch(/\.tmp$/);
    expect(write[2]).toEqual({ encoding: "utf8", mode: 0o600, flag: "wx" });
    expect(fs.renameSync).toHaveBeenCalledWith(write[0], `${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}/SPEC-1.md`);
    expect(files.get(`${PROJECT}/${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}/SPEC-1.md`)).toBe("# Spec\n");
  });

  it("refuses to write when the directory it would write into resolves out of the project", () => {
    links.set(`${PROJECT}/exported`, `${OUTSIDE}/secrets`);
    expect(() => writeFileAtomic(`${PROJECT}/exported/SPEC-1.md`, "# Spec\n", { within: PROJECT })).toThrow(
      /Name a folder inside this project/,
    );
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(files.has(`${OUTSIDE}/secrets/SPEC-1.md`)).toBe(false);
  });

  it("removes a regular file and never what a link points at", () => {
    files.set(`${PROJECT}/docs/old.md`, "gone\n");
    removeFile(`${PROJECT}/docs/old.md`);
    expect(files.has(`${PROJECT}/docs/old.md`)).toBe(false);

    links.set(`${PROJECT}/docs/pointer.md`, `${OUTSIDE}/secrets/notes.md`);
    fs.unlinkSync.mockClear();
    removeFile(`${PROJECT}/docs/pointer.md`);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(files.get(`${OUTSIDE}/secrets/notes.md`)).toBe("someone else's file\n");

    // A file that is already gone is not an error.
    expect(() => removeFile(`${PROJECT}/docs/never.md`)).not.toThrow();
  });

  it("answers what a path is without following it", () => {
    files.set(`${PROJECT}/docs/one.md`, "x\n");
    links.set(`${PROJECT}/docs/pointer.md`, `${PROJECT}/docs/one.md`);
    expect(kindOf(`${PROJECT}/docs/one.md`)).toBe("file");
    expect(kindOf(`${PROJECT}/docs`)).toBe("directory");
    expect(kindOf(`${PROJECT}/docs/pointer.md`)).toBe("link");
    expect(kindOf(`${PROJECT}/docs/absent.md`)).toBe("none");
  });
});
