/**
 * The read-only git publication uses, over a mocked `git` (M21-T21).
 *
 * `checkpointCommit` decides whether a caller's `checkpointId` is a state a
 * `published_as` may be recorded against, so what it accepts is a contract.
 * `git` itself is mocked: every invocation is recorded, the answers are
 * scripted, and the tests assert both the decision and that nothing but a read
 * was ever run. No repository is created and no repository is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** `git -C <cwd> …` calls, in order, without the `-C <cwd>` prefix. */
const calls: string[][] = [];
/** Scripted answers, keyed by the arguments joined with a space. */
const answers = new Map<string, string>();
/** Argument prefixes that must fail, as a git that exited non-zero. */
const failures = new Set<string>();

const execFileSync = vi.fn((file: string, args: readonly string[]) => {
  expect(file).toBe("git");
  expect(args[0]).toBe("-C");
  const rest = args.slice(2) as string[];
  calls.push(rest);
  const key = rest.join(" ");
  if (failures.has(key)) throw new Error("git exited 1");
  const answer = answers.get(key);
  if (answer === undefined) throw new Error(`git exited 1 (${key})`);
  return answer;
});

vi.mock("node:child_process", () => ({ execFileSync }));

const { blobObjectId, checkpointCommit } = await import("../../src/project-work/publish/git.js");
const { CHECKPOINT_REF_NAMESPACE, checkpointRef } = await import("@lasercode/protocol");

const CWD = "/repo";
const SESSION = "a1b2c3";
const REF = checkpointRef(SESSION, 4);
const COMMIT = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

/** What `for-each-ref` would print for one ref, in the format the module asks for. */
function ref(name: string, objectId: string): string {
  return `${name}\0${objectId}\n`;
}

function listing(pattern: string, text: string): void {
  answers.set(`for-each-ref --format=%(refname)%00%(objectname) ${pattern}`, text);
}

function commitExists(objectId: string): void {
  answers.set(`rev-parse --verify --quiet ${objectId}^{commit}`, `${objectId}\n`);
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  failures.clear();
  execFileSync.mockClear();
});

describe("checkpointCommit", () => {
  it("resolves a checkpoint ref this repository holds to the commit it points at", () => {
    listing(REF, ref(REF, COMMIT));
    commitExists(COMMIT);
    expect(checkpointCommit(CWD, REF)).toEqual({ ref: REF, commitObjectId: COMMIT });
    // Two reads, and both of them are reads.
    expect(calls).toEqual([
      ["for-each-ref", "--format=%(refname)%00%(objectname)", REF],
      ["rev-parse", "--verify", "--quiet", `${COMMIT}^{commit}`],
    ]);
  });

  it("refuses an id that is not a checkpoint ref at all, without running git", () => {
    for (const id of ["ckpt_17", "HEAD", "refs/heads/main", "main", `${CHECKPOINT_REF_NAMESPACE}/${SESSION}`, `${CHECKPOINT_REF_NAMESPACE}/${SESSION}/x`, "-x"]) {
      expect(checkpointCommit(CWD, id)).toBeUndefined();
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("refuses a pattern that matched a descendant rather than that exact ref", () => {
    // `for-each-ref <pattern>` matches whole path components, so a caller
    // naming a ref that does not exist can still be answered for one below it.
    const deeper = `${REF}/5`;
    listing(REF, ref(deeper, COMMIT));
    commitExists(COMMIT);
    expect(checkpointCommit(CWD, REF)).toBeUndefined();
    // It stopped at the name: the object was never resolved.
    expect(calls).toEqual([["for-each-ref", "--format=%(refname)%00%(objectname)", REF]]);
  });

  it("refuses when the pattern answered with more than one ref", () => {
    listing(REF, `${ref(`${REF}/1`, COMMIT)}${ref(`${REF}/2`, COMMIT)}`);
    expect(checkpointCommit(CWD, REF)).toBeUndefined();
  });

  it("refuses when the repository has no such ref", () => {
    listing(REF, "");
    expect(checkpointCommit(CWD, REF)).toBeUndefined();

    calls.length = 0;
    answers.delete(`for-each-ref --format=%(refname)%00%(objectname) ${REF}`);
    failures.add(`for-each-ref --format=%(refname)%00%(objectname) ${REF}`);
    expect(checkpointCommit(CWD, REF)).toBeUndefined();
  });

  it("refuses an object id that is not one, and a ref that does not point at a commit", () => {
    listing(REF, ref(REF, "not-an-object-id"));
    expect(checkpointCommit(CWD, REF)).toBeUndefined();
    expect(calls).toEqual([["for-each-ref", "--format=%(refname)%00%(objectname)", REF]]);

    // A ref pointing at a tree or a tag: `rev-parse …^{commit}` answers nothing.
    calls.length = 0;
    listing(REF, ref(REF, COMMIT));
    failures.add(`rev-parse --verify --quiet ${COMMIT}^{commit}`);
    expect(checkpointCommit(CWD, REF)).toBeUndefined();
  });
});

describe("blobObjectId", () => {
  it("computes the id git gives those exact bytes, in the repository's own format", () => {
    // `git hash-object` of an empty file, in both object formats.
    expect(blobObjectId("sha1", "")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(blobObjectId("sha256", "")).toBe("473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813");
    // And it is content, not name: two different strings never share an id.
    expect(blobObjectId("sha1", "# Spec\n")).not.toBe(blobObjectId("sha1", "# Spec"));
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
