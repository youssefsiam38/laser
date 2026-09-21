/**
 * Storage: `<project>/<PROJECT_DIR_NAME>/design/{index,review}.json`, the
 * digest-keyed parse cache in Laser's own state, and the two refusals that
 * keep a committed file honest.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import { afterAll, describe, expect, it } from "vitest";
import {
  absolutePathIn,
  clearParseCache,
  DesignStorageRefused,
  fileParseCache,
  indexPath,
  parseCacheBytes,
  readIndex,
  readReview,
  reviewPath,
  writeIndex,
  writeReview,
} from "../../src/design/index/storage.js";
import { emptyReview } from "../../src/design/index/review.js";
import { buildFixture, cleanupFixtures, copyFixture } from "./helpers.js";

afterAll(cleanupFixtures);

describe("where the index is written", () => {
  it("writes both files under the project's own config directory", async () => {
    const { projectCwd, index } = await buildFixture("vue-scss");
    expect(indexPath(projectCwd)).toBe(join(projectCwd, PROJECT_DIR_NAME, "design", "index.json"));
    expect(existsSync(indexPath(projectCwd))).toBe(true);
    expect(existsSync(reviewPath(projectCwd))).toBe(true);
    const stored = readIndex(projectCwd);
    expect(stored?.indexId).toBe(index.indexId);
    expect(stored?.entries.length).toBe(index.entries.length);
    // Committed with the repository: pretty-printed and newline-terminated.
    expect(readFileSync(indexPath(projectCwd), "utf8").endsWith("}\n")).toBe(true);
  });

  it("round-trips the DTCG document and the review decisions", async () => {
    const { projectCwd, index } = await buildFixture("dtcg-tokens");
    const stored = readIndex(projectCwd);
    expect(JSON.stringify(stored?.tokensDocument)).toEqual(JSON.stringify(index.tokensDocument));
    writeReview(projectCwd, { version: 1, entries: { e_one: { state: "accepted", reviewer: "Rae", reviewerKind: "person", reviewedAt: "2026-02-01T10:00:00.000Z" } }, eras: {} });
    expect(readReview(projectCwd).entries["e_one"]?.reviewer).toBe("Rae");
  });

  it("refuses a document that would carry this machine's paths into the repository", async () => {
    const project = copyFixture("vue-scss");
    const { index } = await buildFixture("vue-scss", { projectCwd: project, write: false });
    const leaky = {
      ...index,
      entries: index.entries.map((entry, position) =>
        position === 0 ? { ...entry, sources: [{ path: "/home/rae/projects/atlas/src/styles/app.scss" }] } : entry,
      ),
    };
    expect(() => writeIndex(project, leaky)).toThrow(DesignStorageRefused);
    try {
      writeIndex(project, leaky);
    } catch (error) {
      expect((error as DesignStorageRefused).code).toBe("absolute_path");
      expect((error as DesignStorageRefused).next).toContain("relative");
    }
  });

  it("does not mistake a route or a URL for a machine path", () => {
    expect(absolutePathIn('{"name": "/products/:id"}')).toBeUndefined();
    expect(absolutePathIn('{"excerpt": "<a href=\\"/pricing\\">"}')).toBeUndefined();
    expect(absolutePathIn('{"path": "/Users/rae/code/app.css"}')).toBe("/Users/rae/code/app.css");
    expect(absolutePathIn('{"path": "~/code/app.css"}')).toBe("~/code/app.css");
    expect(absolutePathIn('{"path": "file:///etc/passwd"}')).toContain("file://");
  });

  it("refuses an index that is not the shape the protocol stores", async () => {
    const project = copyFixture("vue-scss");
    const { index } = await buildFixture("vue-scss", { projectCwd: project, write: false });
    expect(() => writeIndex(project, { ...index, entries: [{ ...index.entries[0]!, kind: "widget" as never }] })).toThrow(/does not match/);
  });

  it("reports a damaged file instead of half-loading it", async () => {
    const { projectCwd } = await buildFixture("vue-scss");
    writeFileSync(indexPath(projectCwd), "{ not json");
    expect(() => readIndex(projectCwd)).toThrow(/not valid JSON/);
    writeFileSync(reviewPath(projectCwd), "{ not json");
    expect(() => readReview(projectCwd)).toThrow(DesignStorageRefused);
  });

  it("answers 'no index yet' rather than throwing for a project that has none", () => {
    const empty = mkdtempSync(join(tmpdir(), "design-empty-"));
    expect(readIndex(empty)).toBeUndefined();
    expect(readReview(empty)).toEqual(emptyReview());
  });
});

describe("the parse cache", () => {
  it("lives in the state directory, is keyed by digest and path, and is disposable", async () => {
    const state = mkdtempSync(join(tmpdir(), "design-state-"));
    const cache = fileParseCache(state, "project-x");
    expect(cache.get("a".repeat(64), "src/app.css")).toBeUndefined();
    cache.set("a".repeat(64), "src/app.css", { facts: [], gaps: [{ path: "src/app.css", reason: "nothing" }] });
    cache.flush();

    const reopened = fileParseCache(state, "project-x");
    expect(reopened.get("a".repeat(64), "src/app.css")?.gaps[0]?.reason).toBe("nothing");
    // The same content at another path is another entry.
    expect(reopened.get("a".repeat(64), "src/other.css")).toBeUndefined();
    expect(reopened.hits()).toBe(1);
    expect(parseCacheBytes(state)).toBeGreaterThan(0);

    clearParseCache(state, "project-x");
    expect(fileParseCache(state, "project-x").get("a".repeat(64), "src/app.css")).toBeUndefined();
  });
});
