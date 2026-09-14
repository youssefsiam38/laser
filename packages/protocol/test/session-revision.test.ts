import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ENVIRONMENT_KEY_PATTERN,
  RevisionCanonicalisationError,
  RevisionFold,
  SESSION_REVISION_PATTERN,
  canonicalJson,
  classifyBaseRevision,
  environmentKeyOf,
  environmentTagOf,
  isEnvironmentKey,
  isSessionRevision,
  sessionRevisionOf,
  type RevisionState,
  type SessionRevisionHeader,
} from "../src/index.js";
import { nodeRevisionHasher } from "../src/session-revision-node.js";

const hash = nodeRevisionHasher;
const header: SessionRevisionHeader = { id: "session-1", cwd: "/project", version: 3 };
const entry = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

/** The fold, its checkpoints and the durable-leaf rule, as both readers apply it. */
function fold(entries: unknown[], header_: SessionRevisionHeader = header): { state: RevisionState; checkpoints: RevisionState[] } {
  const chain = RevisionFold.create(hash, header_);
  const checkpoints: RevisionState[] = [];
  let leafId: string | null = null;
  for (const item of entries) {
    chain.push(item);
    leafId = (item as { id?: string }).id ?? null;
    checkpoints.push({ ...chain.state, leafId });
  }
  return { state: { ...chain.state, leafId }, checkpoints };
}

const revisionOf = (entries: unknown[], tag = environmentTagOf(hash, "env-a")) => sessionRevisionOf(hash, tag, fold(entries).state);

describe("canonical records", () => {
  it("is insensitive to key order and to a JSON round trip, and drops absent members", () => {
    const written = { type: "message", id: "e1", message: { role: "user", content: "hello" } };
    const reordered = { message: { content: "hello", role: "user" }, id: "e1", type: "message" };
    expect(canonicalJson(reordered)).toBe(canonicalJson(written));
    expect(canonicalJson(JSON.parse(JSON.stringify(written)))).toBe(canonicalJson(written));
    expect(canonicalJson({ ...written, parentId: undefined })).toBe(canonicalJson(written));
  });

  it("refuses a value a stored record could never hold, rather than inventing one", () => {
    expect(() => canonicalJson({ id: "e1", n: Number.NaN })).toThrow(RevisionCanonicalisationError);
    expect(() => canonicalJson({ id: "e1", n: 1n })).toThrow(RevisionCanonicalisationError);
    // Arrays keep their length: `JSON.stringify` writes null for a hole too.
    expect(canonicalJson({ a: [1, undefined, 3] })).toBe('{"a":[1,null,3]}');
  });
});

describe("durable revisions", () => {
  it("is content-derived, so the same conversation re-read produces the same value", () => {
    const entries = [entry("e0", null, "one"), entry("e1", "e0", "two")];
    const reparsed = JSON.parse(JSON.stringify(entries)) as unknown[];
    expect(revisionOf(reparsed)).toBe(revisionOf(entries));
    expect(isSessionRevision(revisionOf(entries))).toBe(true);
    expect(SESSION_REVISION_PATTERN.test(revisionOf(entries))).toBe(true);
  });

  it("changes for an append, for a leaf move alone, for the session, and for the environment", () => {
    const entries = [entry("e0", null, "one"), entry("e1", "e0", "two")];
    const base = revisionOf(entries);
    expect(revisionOf([...entries, entry("e2", "e1", "three")])).not.toBe(base);

    const moved = { ...fold(entries).state, leafId: "e0" };
    expect(sessionRevisionOf(hash, environmentTagOf(hash, "env-a"), moved)).not.toBe(base);

    const other = fold(entries, { ...header, id: "session-2" }).state;
    expect(sessionRevisionOf(hash, environmentTagOf(hash, "env-a"), other)).not.toBe(base);
    expect(revisionOf(entries, environmentTagOf(hash, "env-b"))).not.toBe(base);
  });

  it("folds incrementally to the same value as one pass", () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`e${i}`, i ? `e${i - 1}` : null, `m${i}`));
    const resumed = RevisionFold.resume(hash, fold(entries.slice(0, 20)).state);
    for (const item of entries.slice(20)) resumed.push(item);
    const { leafId: _leaf, ...once } = fold(entries).state;
    expect(resumed.state).toEqual(once);
  });

  it("derives a public environment key that is opaque, long and not the raw id", () => {
    const key = environmentKeyOf(hash, "11111111-2222-3333-4444-555555555555");
    expect(isEnvironmentKey(key)).toBe(true);
    expect(ENVIRONMENT_KEY_PATTERN.test(key)).toBe(true);
    // 22 base64url characters carry 132 bits, and nothing of the id itself.
    expect(key.slice(3)).toHaveLength(22);
    expect(key).not.toContain("1111");
    expect(environmentKeyOf(hash, "11111111-2222-3333-4444-555555555555")).toBe(key);
    expect(environmentKeyOf(hash, "22222222-2222-3333-4444-555555555555")).not.toBe(key);
    // The revision's binding is a prefix of exactly the same digest, so a
    // revision discloses nothing the published key does not.
    const digest = createHash("sha256").update("r1|envkey|11111111-2222-3333-4444-555555555555", "utf8").digest("base64url");
    expect(environmentTagOf(hash, "11111111-2222-3333-4444-555555555555")).toBe(digest.slice(0, 8));
    expect(key).toBe(`e1.${digest.slice(0, 22)}`);
  });
});

describe("what a cached revision is worth", () => {
  const tag = environmentTagOf(hash, "env-a");
  const entries = [entry("e0", null, "one"), entry("e1", "e0", "two"), entry("e2", "e1", "three")];
  const classify = (baseRevision: string, current: unknown[], branch: string[]) =>
    classifyBaseRevision({
      hash,
      environmentTag: tag,
      baseRevision,
      current: fold(current).state,
      candidates: fold(current).checkpoints,
      onBranch: (leafId) => leafId !== null && branch.includes(leafId),
    });

  it("proves a prefix rather than merely noticing a difference", () => {
    const cached = revisionOf(entries.slice(0, 2));
    expect(classify(cached, entries, ["e0", "e1", "e2"])).toBe("prefix");
    expect(classify(revisionOf(entries), entries, ["e0", "e1", "e2"])).toBe("current");
  });

  it("refuses a base whose prefix was rewritten, even at the same length", () => {
    const cached = revisionOf(entries.slice(0, 2));
    const edited = [entry("e0", null, "one"), entry("e1", "e0", "changed"), entries[2]];
    expect(classify(cached, edited, ["e0", "e1", "e2"])).toBe("stale");
  });

  it("refuses a suffix containing a Pi compaction or branch-summary barrier", () => {
    const cached = revisionOf(entries);
    for (const type of ["compaction", "branch_summary"] as const) {
      const barrier = { type, id: `${type}-1`, parentId: "e2", summary: "Earlier context summarized" };
      expect(classify(cached, [...entries, barrier], ["e0", "e1", "e2", barrier.id])).toBe("stale");
    }
  });

  it("refuses a base on an abandoned branch, and one from another environment", () => {
    const cached = revisionOf(entries.slice(0, 2));
    expect(classify(cached, entries, ["e0", "e2"])).toBe("stale");
    expect(classify(revisionOf(entries.slice(0, 2), environmentTagOf(hash, "env-b")), entries, ["e0", "e1", "e2"])).toBe("stale");
  });

  it("refuses a base older than the states still retained, instead of guessing", () => {
    const long = Array.from({ length: 40 }, (_, i) => entry(`e${i}`, i ? `e${i - 1}` : null, `m${i}`));
    const cached = revisionOf(long.slice(0, 5));
    const retained = fold(long).checkpoints.slice(-10);
    expect(
      classifyBaseRevision({
        hash,
        environmentTag: tag,
        baseRevision: cached,
        current: fold(long).state,
        candidates: retained,
        onBranch: () => true,
      }),
    ).toBe("stale");
    expect(classify("not-a-revision", long, long.map((item) => (item as { id: string }).id))).toBe("stale");
  });
});
