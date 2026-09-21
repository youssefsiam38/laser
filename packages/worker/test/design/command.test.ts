/**
 * The build as a command: progress by files, a budget, a stop, and a
 * re-index that only re-parses what changed (`docs/design-phase.md`,
 * "Re-index").
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDesignIndex, progressLine, startDesignIndexBuild, type DesignBuildProgress } from "../../src/design/index/command.js";
import { fileParseCache, cachePath } from "../../src/design/index/storage.js";
import { cleanupFixtures, copyFixture } from "./helpers.js";

afterAll(cleanupFixtures);

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "design-state-"));
}

describe("progress", () => {
  it("counts files and never reports a percentage", async () => {
    const project = copyFixture("react-tailwind");
    const seen: DesignBuildProgress[] = [];
    const result = await buildDesignIndex({ projectCwd: project, onProgress: (progress) => seen.push({ ...progress }) });

    expect(seen[0]?.phase).toBe("scanning");
    expect(seen.at(-1)?.phase).toBe("done");
    expect(result.progress.filesParsed).toBeGreaterThan(5);
    expect(seen.map((progress) => progress.filesParsed)).toEqual([...seen.map((progress) => progress.filesParsed)].sort((left, right) => left - right));
    for (const progress of seen) {
      expect(progressLine(progress)).not.toMatch(/%/);
      expect(Object.keys(progress)).not.toContain("percent");
    }
    expect(progressLine(result.progress)).toContain("files");
  });

  it("names the phases a fleet row shows, in order", async () => {
    const project = copyFixture("vue-scss");
    const phases: string[] = [];
    await buildDesignIndex({ projectCwd: project, onProgress: (progress) => phases.push(progress.phase) });
    expect([...new Set(phases)]).toEqual(["scanning", "parsing", "grouping", "writing", "done"]);
  });
});

describe("a re-index", () => {
  it("re-parses only the files whose digest changed", async () => {
    const project = copyFixture("react-tailwind");
    const state = stateDir();
    const cache = fileParseCache(state, "project-a");
    const first = await buildDesignIndex({ projectCwd: project, cache });
    expect(first.reparsed.length).toBeGreaterThan(5);
    expect(first.progress.filesFromCache).toBe(0);

    // Nothing changed: the second build opens no parser at all.
    const unchanged = await buildDesignIndex({ projectCwd: project, cache: fileParseCache(state, "project-a") });
    expect(unchanged.reparsed).toEqual([]);
    expect(unchanged.progress.filesFromCache).toBe(unchanged.progress.filesParsed);

    // One file changes: exactly that file is re-parsed.
    const css = join(project, "src", "index.css");
    writeFileSync(css, `${readFileSync(css, "utf8")}\n.new { color: #14b8a6; }\n`);
    const incremental = await buildDesignIndex({ projectCwd: project, cache: fileParseCache(state, "project-a") });
    expect(incremental.reparsed).toEqual(["src/index.css"]);
    expect(incremental.progress.filesFromCache).toBe(incremental.progress.filesParsed - 1);
  });

  it("keeps its cache in the state directory, never in the project", async () => {
    const project = copyFixture("vue-scss");
    const state = stateDir();
    await buildDesignIndex({ projectCwd: project, cache: fileParseCache(state, "project-b") });
    const path = cachePath(state, "project-b");
    expect(path.startsWith(state)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: expect.any(Number) });
  });

  it("produces the same index whether or not the cache answered", async () => {
    const project = copyFixture("monorepo-eras");
    const state = stateDir();
    const cold = await buildDesignIndex({ projectCwd: project, cache: fileParseCache(state, "project-c") });
    const warm = await buildDesignIndex({ projectCwd: project, cache: fileParseCache(state, "project-c") });
    expect(warm.progress.filesFromCache).toBeGreaterThan(0);
    expect(JSON.stringify({ ...warm.index, builtAt: "" })).toEqual(JSON.stringify({ ...cold.index, builtAt: "" }));
  });
});

describe("bounds", () => {
  it("stops at its file budget and says so, instead of half-claiming the project", async () => {
    const project = copyFixture("react-tailwind");
    const result = await buildDesignIndex({ projectCwd: project, budget: { maxFiles: 3 } });
    expect(result.stopped).toBe(true);
    expect(result.index.stoppedEarly).toBe(true);
    expect(result.index.gaps.some((gap) => gap.reason.includes("budget"))).toBe(true);
  });

  it("stops when the person stops it, and keeps what it had read", async () => {
    const project = copyFixture("react-tailwind");
    const controller = new AbortController();
    let files = 0;
    const result = await buildDesignIndex({
      projectCwd: project,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "parsing" && ++files === 2) controller.abort();
      },
    });
    expect(result.stopped).toBe(true);
    expect(result.index.gaps.some((gap) => gap.reason.includes("you stopped this build"))).toBe(true);
    expect(result.index.entries.length).toBeGreaterThan(0);
  });

  it("runs as a command a fleet row can title, follow and stop", async () => {
    const project = copyFixture("rails-templates");
    const command = startDesignIndexBuild({ projectCwd: project });
    expect(command.id).toMatch(/^cmd_[0-9a-f]+$/);
    expect(command.title.length).toBeGreaterThan(0);
    const result = await command.done;
    expect(result.index.entries.length).toBeGreaterThan(0);
    expect(command.progress().phase).toBe("done");
    // Stopping a finished command changes nothing and throws nothing.
    command.stop();
    expect(command.progress().phase).toBe("done");
  });
});
