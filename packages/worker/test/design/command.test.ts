/**
 * The build as a command: progress by files, a budget, a stop, and a
 * re-index that only re-parses what changed (`docs/design-phase.md`,
 * "Re-index").
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelProfile } from "@lasercode/protocol";
import { buildDesignIndex, progressLine, startDesignIndexBuild, type DesignBuildProgress } from "../../src/design/index/command.js";
import { fileParseCache, cachePath, indexPath } from "../../src/design/index/storage.js";
import type { CompletionRuntime } from "../../src/agents/session-naming.js";
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
    // A budget is not a person: whatever a row says about this build, it must
    // not tell someone they stopped it.
    expect(result.stoppedBy).toBe("budget");
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
    expect(result.stoppedBy).toBe("person");
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

/**
 * What a stopped build says about itself (M21-T10/T13 continuation).
 *
 * A person who presses Stop and then reads *completed* has been told something
 * untrue about their own project. The flag used to be decided in the file loop
 * alone, so a Stop accepted anywhere else — while the model was describing,
 * while the index was being written — was simply forgotten by the time the
 * outcome was written.
 *
 * The rule these prove: an abort **accepted before the outcome exists** makes
 * the build stopped, whatever else came back; everything already parsed is
 * still kept and still written; a real write failure is still a failure; and a
 * Stop that lands after the build has settled changes nothing, because settled
 * is settled.
 */
describe("a Stop, and what the outcome says about it", () => {
  const PROFILE: ModelProfile = {
    id: "mp_design",
    name: "Design",
    models: [{ provider: "stub", id: "stub-1" }],
    origin: "person",
    updatedAt: "2026-02-03T10:00:00.000Z",
  };

  /** A model that answers whenever it is asked, so nothing here waits on a clock. */
  const answering = (): CompletionRuntime => ({
    getModel: (provider, id) => ({ provider, id }),
    completeSimple: async () => ({ content: [{ type: "text", text: JSON.stringify({ components: [] }) }] }),
  });

  it("ends a build stopped while the model was answering, however good the descriptions are", async () => {
    const project = copyFixture("react-tailwind");
    const controller = new AbortController();
    let asked = 0;
    const result = await buildDesignIndex({
      projectCwd: project,
      signal: controller.signal,
      synthesis: {
        profile: PROFILE,
        // The Stop lands while the model is answering — the one long await of
        // the whole build, and the window the file loop's flag could not see.
        models: async () => {
          asked += 1;
          controller.abort();
          return answering();
        },
      },
    });

    expect(asked, "the build really reached the describing step").toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.stoppedBy).toBe("person");
    expect(result.progress.phase).toBe("stopped");
    // Stopped is not lost: everything parsed before it is in the index, and the
    // index it had is still written.
    expect(result.index.entries.length).toBeGreaterThan(0);
    expect(result.indexPath).toBeDefined();
  });

  it("ends a build stopped before it opened a single file", async () => {
    const project = copyFixture("react-tailwind");
    const controller = new AbortController();
    controller.abort();

    const result = await buildDesignIndex({ projectCwd: project, signal: controller.signal });

    expect(result.stopped).toBe(true);
    expect(result.stoppedBy).toBe("person");
    expect(result.progress.phase).toBe("stopped");
    expect(result.progress.filesParsed).toBe(0);
    expect(result.index.stoppedEarly).toBe(true);
  });

  it("ends a build stopped at the last moment it could still be stopped", async () => {
    const project = copyFixture("react-tailwind");
    const controller = new AbortController();
    // `writing` is reported before the write: the Stop is accepted after the
    // parse and after synthesis, and before the outcome exists.
    const result = await buildDesignIndex({
      projectCwd: project,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "writing") controller.abort();
      },
    });

    expect(result.stopped).toBe(true);
    expect(result.stoppedBy).toBe("person");
    expect(result.progress.phase).toBe("stopped");
    // It had read the whole project, and what it read was written anyway.
    expect(result.progress.filesParsed).toBe(result.progress.filesFound);
    expect(result.indexPath).toBeDefined();
  });

  it("says nothing of the sort about a build that ran to its end", async () => {
    const project = copyFixture("react-tailwind");
    const controller = new AbortController();
    const result = await buildDesignIndex({ projectCwd: project, signal: controller.signal });

    expect(result.stopped).toBe(false);
    expect(result.stoppedBy).toBeUndefined();
    expect(result.progress.phase).toBe("done");
    expect(result.index.stoppedEarly).toBeUndefined();
  });

  it("reports a write that failed as the failure it is, Stop in hand or not", async () => {
    const project = copyFixture("react-tailwind");
    // The index file's own path is a directory, so the store's rename cannot
    // land: the real way a build fails.
    mkdirSync(indexPath(project), { recursive: true });
    const controller = new AbortController();

    await expect(
      buildDesignIndex({
        projectCwd: project,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "writing") controller.abort();
        },
      }),
      "being stopped never hides a failure",
    ).rejects.toThrow();
  });

  it("does not relabel a build that had already settled", async () => {
    const project = copyFixture("vue-scss");
    const command = startDesignIndexBuild({ projectCwd: project });
    const result = await command.done;
    expect(result.stopped).toBe(false);

    command.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.stopped, "settled is settled").toBe(false);
    expect(result.stoppedBy).toBeUndefined();
    expect(command.progress().phase).toBe("done");
  });
});
