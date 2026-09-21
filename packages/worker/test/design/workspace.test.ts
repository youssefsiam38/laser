/**
 * The design workspace over the wire shapes (M21-T13).
 *
 * The window asks six questions and this is what it gets: an index it can
 * read, a review that survives a re-read from disk, a Command it can watch by
 * *files* and stop, a page grounded with both strategies, and a sketch reborn
 * as a validated tree with the list of what did not map.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { designWorkspaceResultSchemas, type BackgroundTask } from "@lasercode/protocol";
import { reviewPath } from "../../src/design/index/storage.js";
import { DesignWorkspace, designCommandTaskId } from "../../src/design/workspace.js";
import { progressLine, type DesignBuildCommand, type DesignBuildProgress } from "../../src/design/index/command.js";
import { ProjectDesignIndex } from "../../src/design/index/bridge.js";
import { ProjectHostGrounding } from "../../src/design/host/ground.js";
import { cleanupFixtures, copyFixture } from "./helpers.js";

afterAll(cleanupFixtures);

function workspaceFor(projectCwd: string, published: Array<{ path: string; task: BackgroundTask }> = []) {
  // Wired exactly as the worker wires it: the index reports to the workspace,
  // the workspace publishes the row.
  let workspace!: DesignWorkspace;
  const index = new ProjectDesignIndex({
    projectCwd,
    stateDir: join(projectCwd, ".state"),
    projectKey: "fixture",
    onCommand: (command) => workspace.observeCommand(command),
    onProgress: (commandId, progress) => workspace.observeProgress(commandId, progress),
  });
  const grounding = new ProjectHostGrounding({ projectCwd, index: async () => (await index.index()) ?? undefined });
  workspace = new DesignWorkspace({
    projectCwd,
    index: () => index,
    grounding: () => grounding,
    publishTask: (path, task) => published.push({ path, task }),
  });
  return { workspace, index, published };
}

const PROJECT_ID = "pw_9f2c1a0400000000000000000000";

describe("design/index/get", () => {
  it("says a project has never been indexed rather than answering an empty index", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const answer = await workspace.get({ projectId: PROJECT_ID });
    expect(answer.state).toBe("absent");
    expect(answer.index).toBeUndefined();
    expect(answer.detail).toMatch(/not been indexed/i);
    expect(designWorkspaceResultSchemas["design/index/get"].parse(answer)).toEqual(answer);
  });

  it("answers the reviewed index and its review progress once one is built", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    const answer = await workspace.get({ projectId: PROJECT_ID });
    expect(answer.state).toBe("ready");
    expect(answer.index?.entries.length ?? 0).toBeGreaterThan(0);
    expect(answer.progress?.total).toBe(answer.index?.entries.length);
    expect(answer.progress?.reviewed).toBe(0);
    expect(designWorkspaceResultSchemas["design/index/get"].parse(answer)).toEqual(answer);
  });
});

describe("design/index/build", () => {
  it("reports progress by files and never a percentage", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID, sessionPath: "/s.jsonl" });
    expect(Object.keys(command)).not.toContain("percent");
    await waitForCommand(workspace, command.commandId);
    const after = (await workspace.get({ projectId: PROJECT_ID })).commands[0];
    expect(after?.running).toBe(false);
    expect(after?.phase).toBe("done");
    expect(after?.filesParsed ?? 0).toBeGreaterThan(0);
  });

  it("takes a fleet row under the session that started it, and ends it when the build ends", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    const { workspace } = workspaceFor(projectCwd, published);
    const { command } = await workspace.build({ projectId: PROJECT_ID, sessionPath: "/s.jsonl" });
    await waitForCommand(workspace, command.commandId);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((entry) => entry.path === "/s.jsonl")).toBe(true);
    expect(published.every((entry) => entry.task.id === designCommandTaskId(command.commandId))).toBe(true);
    expect(published[0]?.task.status).toBe("running");
    const last = published[published.length - 1]?.task;
    expect(last?.status).toBe("completed");
    expect(last?.endedAt).toBeDefined();
    // The line a collapsed row shows is files, never a percentage.
    expect(last?.activity).toMatch(/files/);
    expect(last?.activity).not.toMatch(/%/);
  });

  it("publishes no row at all when no session started it", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    const { workspace } = workspaceFor(projectCwd, published);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    expect(published).toEqual([]);
  });

  it("stops on request, from the panel and from the fleet row alike", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const first = await workspace.build({ projectId: PROJECT_ID });
    const stopped = workspace.stop({ projectId: PROJECT_ID, commandId: first.command.commandId });
    expect(stopped.stopped).toBe(true);
    await waitForCommand(workspace, first.command.commandId);

    const second = await workspace.build({ projectId: PROJECT_ID });
    expect(workspace.stopByTaskId(designCommandTaskId(second.command.commandId))).toBe(true);
    expect(workspace.stopByTaskId("t-42")).toBe(false);
    await waitForCommand(workspace, second.command.commandId);
  });

  it("refuses to pretend it stopped a build it never had", () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    expect(workspace.stop({ projectId: PROJECT_ID, commandId: "nope" })).toEqual({ stopped: false });
  });
});

/**
 * What a worker keeps about builds that have ended (review F4).
 *
 * A project that re-indexes all day must not grow one row per build for the
 * life of the worker, and nothing a person is still watching may be dropped
 * to make room. The engine is stubbed here so the phases are the test's, not
 * a real parse's.
 */
describe("finished builds are kept, bounded", () => {
  function stubbedWorkspace() {
    const published: BackgroundTask[] = [];
    const commands = new Map<string, { command: DesignBuildCommand; settle: () => void; stops: number }>();
    let workspace!: DesignWorkspace;
    let next = 0;
    const engine = {
      startBuild: async () => {
        next += 1;
        const id = `cmd-${String(next)}`;
        let done!: () => void;
        const finished = new Promise<void>((resolve) => (done = resolve));
        let phase: "scanning" | "done" | "stopped" = "scanning";
        const progress = (): DesignBuildProgress => ({ phase, filesParsed: 1, filesFound: 1, filesFromCache: 0, elapsedMs: 1 });
        const held = {
          command: {
            id,
            title: `Build ${id}`,
            progress,
            stop: () => {
              held.stops += 1;
              phase = "stopped";
            },
            done: finished.then(() => ({ progress: progress() })),
          } as unknown as DesignBuildCommand,
          settle: () => {
            if (phase === "scanning") phase = "done";
            done();
          },
          stops: 0,
        };
        commands.set(id, held);
        workspace.observeCommand(held.command);
        return { commandId: id, title: held.command.title, appRoot: "." };
      },
      command: (id: string) => commands.get(id)?.command,
      index: async () => undefined,
      stop: (id: string) => {
        const held = commands.get(id);
        if (!held) return false;
        held.settle();
        return true;
      },
    };
    workspace = new DesignWorkspace({
      projectCwd: "/project",
      index: () => engine as never,
      grounding: () => ({}) as never,
      publishTask: (_path, task) => published.push(task),
    });
    const run = async (settle = true): Promise<string> => {
      const { command } = await workspace.build({ projectId: PROJECT_ID, sessionPath: "/s.jsonl" });
      if (settle) {
        commands.get(command.commandId)!.settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return command.commandId;
    };
    return { workspace, published, commands, run };
  }

  it("forgets the oldest finished builds, after their last row has been published", async () => {
    const { workspace, published, run } = stubbedWorkspace();
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) ids.push(await run());

    const kept = (await workspace.get({ projectId: PROJECT_ID })).commands.map((command) => command.commandId);
    expect(kept.length).toBe(8);
    // The newest are the ones kept, in start order.
    expect(kept).toEqual(ids.slice(-8));

    // Nothing was forgotten before the fleet was told how it ended: every
    // build, including the evicted ones, published a terminal row.
    for (const id of ids) {
      const rows = published.filter((task) => task.id === designCommandTaskId(id));
      expect(rows.length, id).toBeGreaterThan(0);
      expect(rows[rows.length - 1]?.status, id).toBe("completed");
      expect(rows[rows.length - 1]?.endedAt, id).toBeDefined();
    }
  });

  it("never evicts a build that is still running, however many have ended since", async () => {
    const { workspace, commands, run } = stubbedWorkspace();
    const running = await run(false);
    for (let index = 0; index < 12; index += 1) await run();

    const listed = (await workspace.get({ projectId: PROJECT_ID })).commands;
    expect(listed.find((command) => command.commandId === running)?.running).toBe(true);
    expect(listed.length).toBe(9);

    // And once it ends it is bounded like any other.
    commands.get(running)!.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await run();
    expect((await workspace.get({ projectId: PROJECT_ID })).commands.length).toBe(8);
  });

  it("answers Stop the same way however often it is asked, and after the build is forgotten", async () => {
    const { workspace, commands, run } = stubbedWorkspace();
    const id = await run(false);
    expect(workspace.stop({ projectId: PROJECT_ID, commandId: id }).stopped).toBe(true);
    expect(workspace.stop({ projectId: PROJECT_ID, commandId: id }).stopped).toBe(true);
    expect(commands.get(id)!.stops).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (let index = 0; index < 9; index += 1) await run();
    expect((await workspace.get({ projectId: PROJECT_ID })).commands.some((command) => command.commandId === id)).toBe(false);
    // Forgotten is not an error: Stop still answers, and says it had nothing.
    expect(workspace.stop({ projectId: PROJECT_ID, commandId: id })).toEqual({ stopped: true });
    expect(workspace.stopByTaskId(designCommandTaskId(id))).toBe(false);
  });
});

describe("design/index/review", () => {
  it("persists a decision into review.json and answers the whole reviewed index", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    const before = await workspace.get({ projectId: PROJECT_ID });
    const entry = before.index?.entries.find((candidate) => candidate.kind === "component");
    expect(entry).toBeDefined();

    const answer = await workspace.review({ projectId: PROJECT_ID, entryId: entry!.id, action: "accept" }, { kind: "person", label: "You" });
    expect(answer.index.entries.find((candidate) => candidate.id === entry!.id)?.review.state).toBe("accepted");
    expect(answer.progress.reviewed).toBe(1);
    expect(designWorkspaceResultSchemas["design/index/review"].parse(answer)).toEqual(answer);

    // The decision is on disk, attributed, and survives a fresh read.
    const document = JSON.parse(readFileSync(reviewPath(projectCwd), "utf8")) as {
      entries: Record<string, { state: string; reviewer: string; reviewerKind: string }>;
    };
    expect(document.entries[entry!.id]?.state).toBe("accepted");
    expect(document.entries[entry!.id]?.reviewerKind).toBe("person");
    const reread = await workspaceFor(projectCwd).workspace.get({ projectId: PROJECT_ID });
    expect(reread.index?.entries.find((candidate) => candidate.id === entry!.id)?.review.state).toBe("accepted");
  });

  it("renames an entry and keeps the name the parse found", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    const entry = (await workspace.get({ projectId: PROJECT_ID })).index?.entries.find((candidate) => candidate.kind === "component");
    const answer = await workspace.review(
      { projectId: PROJECT_ID, entryId: entry!.id, action: "rename", name: "Primary button" },
      { kind: "person", label: "You" },
    );
    const renamed = answer.index.entries.find((candidate) => candidate.id === entry!.id);
    expect(renamed?.name).toBe("Primary button");
    expect(renamed?.review.renamedFrom).toBe(entry!.name);
  });

  it("refuses an entry that is not in the index, with what to do next", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    await expect(workspace.review({ projectId: PROJECT_ID, entryId: "nope", action: "accept" }, { kind: "person", label: "You" })).rejects.toThrow(
      /no entry|Next:/i,
    );
  });

  it("refuses a review on a project with no index", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    await expect(workspace.review({ projectId: PROJECT_ID, entryId: "e", action: "accept" }, { kind: "person", label: "You" })).rejects.toThrow(
      /design index|indexed/i,
    );
  });
});

describe("design/host/ground", () => {
  it("grounds a route into a frozen outline with both strategies", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    const answer = await workspace.ground({ projectId: PROJECT_ID, routeOrPath: "/settings", featureSize: "large" });
    expect(answer.hostPage?.fidelity).toBe("mapped");
    expect(answer.hostPage?.outline.length ?? 0).toBeGreaterThan(0);
    expect(answer.strategy?.conform.reasons.length ?? 0).toBeGreaterThan(0);
    expect(answer.strategy?.island.reasons.length ?? 0).toBeGreaterThan(0);
    expect(["conform", "island"]).toContain(answer.strategy?.recommended);
    expect(designWorkspaceResultSchemas["design/host/ground"].parse(answer)).toEqual(answer);
  });

  it("names the pages that could have been meant when nothing resolves", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const answer = await workspace.ground({ projectId: PROJECT_ID, routeOrPath: "/nothing-like-this" });
    expect(answer.hostPage).toBeUndefined();
    expect(answer.detail).toContain("/nothing-like-this");
    expect(designWorkspaceResultSchemas["design/host/ground"].parse(answer)).toEqual(answer);
  });
});

describe("design/sketch/ground", () => {
  it("rebuilds a sketch as a validated tree and lists what did not map", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build({ projectId: PROJECT_ID });
    await waitForCommand(workspace, command.commandId);
    const answer = await workspace.groundSketchDocument({
      projectId: PROJECT_ID,
      document:
        '<!doctype html><html><body><main><h1>Orders</h1><canvas id="chart"></canvas><button class="btn">Refresh</button></main>' +
        "<script>const rows=data.filter(r=>r.open);</script></body></html>",
      screenName: "Orders, grounded",
    });
    expect(answer.screen.name).toBe("Orders, grounded");
    expect(designWorkspaceResultSchemas["design/sketch/ground"].parse(answer)).toEqual(answer);
    expect(answer.unmapped.length).toBeGreaterThan(0);
    // The sketch's live filtering is recorded as a state, never as script.
    expect(answer.states.find((state) => state.name === "filtered")?.included).toBe(false);
    expect(JSON.stringify(answer)).not.toContain("data.filter");
  });

  it("refuses nothing on a project with no index, and says every node is proposed", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const answer = await workspace.groundSketchDocument({ projectId: PROJECT_ID, document: "<section><p>Hello</p></section>" });
    expect(answer.screen.fidelity).toBe("proposed");
    expect(answer.notes.join(" ")).toMatch(/no design index/i);
  });
});

describe("the progress line", () => {
  it("counts files, names the phase and never invents a percentage", () => {
    const line = progressLine({ phase: "parsing", filesParsed: 12, filesFound: 240, filesFromCache: 3, currentPath: "src/Button.tsx", elapsedMs: 900 });
    expect(line).toBe("Reading 12 of 240 files, 3 unchanged");
    expect(line).not.toContain("%");
  });
});

/** Wait for one build to settle, whatever it settled as. */
async function waitForCommand(workspace: DesignWorkspace, commandId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const answer = await workspace.get({ projectId: PROJECT_ID });
    const command = answer.commands.find((candidate) => candidate.commandId === commandId);
    if (command && !command.running) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`build ${commandId} never settled`);
}
