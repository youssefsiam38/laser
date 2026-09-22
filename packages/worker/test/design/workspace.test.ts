/**
 * The design workspace over the wire shapes (M21-T13).
 *
 * The window asks six questions and this is what it gets: an index it can
 * read, a review that survives a re-read from disk, a Command it can watch by
 * *files* and stop, a page grounded with both strategies, and a sketch reborn
 * as a validated tree with the list of what did not map.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { designWorkspaceResultSchemas, type BackgroundTask, type ModelProfile } from "@lasercode/protocol";
import { DesignStorageRefused, indexPath, reviewPath } from "../../src/design/index/storage.js";
import { DesignWorkspace, designCommandIdOf, designCommandTaskId } from "../../src/design/workspace.js";
import { progressLine, type DesignBuildCommand, type DesignBuildProgress, type DesignBuildResult } from "../../src/design/index/command.js";
import { FINISHED_COMMANDS_KEPT, ProjectDesignIndex } from "../../src/design/index/bridge.js";
import { ProjectHostGrounding } from "../../src/design/host/ground.js";
import { cleanupFixtures, copyFixture } from "./helpers.js";

afterAll(cleanupFixtures);

/** The conversations this worker "holds" in these tests. */
const SESSION = "/s.jsonl";
/** A child agent's session: a worktree of the same project, its own cwd. */
const CHILD_SESSION = "/p/.worktrees/agent-1/c.jsonl";

function workspaceFor(projectCwd: string, published: Array<{ path: string; task: BackgroundTask }> = [], held: readonly string[] = [SESSION, CHILD_SESSION]) {
  // Wired exactly as the worker wires it: the index reports to the workspace,
  // the workspace publishes the row.
  let workspace!: DesignWorkspace;
  const index = new ProjectDesignIndex({
    projectCwd,
    stateDir: join(projectCwd, ".state"),
    projectKey: "fixture",
    onCommand: (command, owner) => workspace.observeCommand(command, owner),
    onProgress: (commandId, progress) => workspace.observeProgress(commandId, progress),
    onSettled: (command, owner, outcome) => workspace.observeSettled(command, owner, outcome),
  });
  const grounding = new ProjectHostGrounding({ projectCwd, index: async () => (await index.index()) ?? undefined });
  workspace = new DesignWorkspace({
    projectCwd,
    index: () => index,
    grounding: () => grounding,
    publishTask: (path, task) => published.push({ path, task }),
    holdsSession: (path) => held.includes(path),
  });
  return { workspace, index, published };
}

const PROJECT_ID = "pw_9f2c1a0400000000000000000000";

/** A build owned by the ordinary session, for a test about something else. */
function buildParams(over: Partial<{ appRoot: string; maxFiles: number; rebuild: boolean; sessionPath: string }> = {}) {
  return { projectId: PROJECT_ID, sessionPath: SESSION, ...over };
}

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
    const { command } = await workspace.build(buildParams());
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
    const { command } = await workspace.build(buildParams());
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
    const { command } = await workspace.build(buildParams());
    await waitForCommand(workspace, command.commandId);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((entry) => entry.path === SESSION)).toBe(true);
    expect(published.every((entry) => entry.task.id === designCommandTaskId(command.commandId))).toBe(true);
    expect(published[0]?.task.status).toBe("running");
    const last = published[published.length - 1]?.task;
    expect(last?.status).toBe("completed");
    expect(last?.endedAt).toBeDefined();
    // The line a collapsed row shows is files, never a percentage.
    expect(last?.activity).toMatch(/files/);
    expect(last?.activity).not.toMatch(/%/);
  });

  it("refuses a build that no conversation would own, before it reads anything", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    const { workspace, index } = workspaceFor(projectCwd, published);
    await expect(workspace.build({ projectId: PROJECT_ID, sessionPath: "" })).rejects.toThrow(/watched and stopped|Next:/);
    // Nothing started, nothing published, nothing written: a refusal is not a
    // build with a missing row.
    expect(published).toEqual([]);
    expect(index.commands()).toEqual([]);
    expect(existsSync(indexPath(projectCwd))).toBe(false);
  });

  it("refuses a conversation this worker does not hold, whatever project it belongs to", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    const { workspace, index } = workspaceFor(projectCwd, published);
    await expect(workspace.build({ projectId: PROJECT_ID, sessionPath: "/other-project/s.jsonl" })).rejects.toThrow(/not open in this project/);
    expect(published).toEqual([]);
    expect(index.commands()).toEqual([]);
    expect(existsSync(indexPath(projectCwd))).toBe(false);
  });

  it("lets a child agent's worktree session own a build, and hangs the row under it", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    const { workspace } = workspaceFor(projectCwd, published);
    const { command } = await workspace.build(buildParams({ sessionPath: CHILD_SESSION }));
    expect(command.sessionPath).toBe(CHILD_SESSION);
    await waitForCommand(workspace, command.commandId);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((entry) => entry.path === CHILD_SESSION)).toBe(true);
  });

  it("keeps each session's own build when two start at once", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    const { workspace } = workspaceFor(projectCwd, published);
    const [first, second] = await Promise.all([
      workspace.build(buildParams({ sessionPath: SESSION })),
      workspace.build(buildParams({ sessionPath: CHILD_SESSION })),
    ]);
    expect(first.command.sessionPath).toBe(SESSION);
    expect(second.command.sessionPath).toBe(CHILD_SESSION);
    await waitForCommand(workspace, first.command.commandId);
    await waitForCommand(workspace, second.command.commandId);
    // Neither build's rows ever moved to the other's conversation.
    const rowsOf = (id: string) => published.filter((entry) => entry.task.id === designCommandTaskId(id));
    expect(new Set(rowsOf(first.command.commandId).map((entry) => entry.path))).toEqual(new Set([SESSION]));
    expect(new Set(rowsOf(second.command.commandId).map((entry) => entry.path))).toEqual(new Set([CHILD_SESSION]));
    const listed = (await workspace.get({ projectId: PROJECT_ID })).commands;
    expect(listed.map((command) => command.sessionPath).sort()).toEqual([CHILD_SESSION, SESSION].sort());
  });

  it("stops on request, from the panel and from the fleet row alike", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const first = await workspace.build(buildParams());
    const stopped = workspace.stop({ projectId: PROJECT_ID, commandId: first.command.commandId });
    expect(stopped.stopped).toBe(true);
    await waitForCommand(workspace, first.command.commandId);

    const second = await workspace.build(buildParams());
    expect(workspace.stopByTaskId(designCommandTaskId(second.command.commandId))).toBe(true);
    expect(workspace.stopByTaskId("t-42")).toBe(false);
    await waitForCommand(workspace, second.command.commandId);
  });

  it("refuses to pretend it stopped a build it never had", () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    expect(workspace.stop({ projectId: PROJECT_ID, commandId: "nope" })).toEqual({ stopped: false });
  });

  /**
   * The index keeps its own bound, not one a caller maintains for it: the
   * tools, the workspace and a scripted world all start builds through it, and
   * a closure over a whole build is not something to hold for the life of a
   * worker.
   */
  it("bounds the commands the index itself remembers", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace, index } = workspaceFor(projectCwd);
    const run = async (): Promise<void> => {
      const { command } = await workspace.build(buildParams({ maxFiles: 1 }));
      await waitForCommand(workspace, command.commandId);
    };
    for (let attempt = 0; attempt < 11; attempt += 1) await run();
    // The sweep is the settlement's own, so the bound holds as soon as the
    // eleventh build has ended — without a twelfth to trigger it.
    expect(index.commands().length).toBe(FINISHED_COMMANDS_KEPT);
    for (let attempt = 0; attempt < 9; attempt += 1) await run();
    // And it stays there: the map does not grow with the number of builds.
    expect(index.commands().length).toBe(FINISHED_COMMANDS_KEPT);
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
      startBuild: async (input: { owner: { sessionPath: string } }) => {
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
          // Wired the way the real index wires it: the outcome is announced
          // while the build is still held, and only then does it end.
          settle: () => {
            if (phase === "scanning") phase = "done";
            workspace.observeSettled(held.command, input.owner, {
              kind: "done",
              result: { progress: progress(), stopped: phase === "stopped" } as unknown as DesignBuildResult,
            });
            done();
          },
          stops: 0,
        };
        commands.set(id, held);
        workspace.observeCommand(held.command, input.owner);
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
      holdsSession: () => true,
    });
    const run = async (settle = true): Promise<string> => {
      const { command } = await workspace.build({ projectId: PROJECT_ID, sessionPath: SESSION });
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

/**
 * What a burst of builds leaves behind, and what a failing build says.
 *
 * Both are about the same moment — settlement — and both are taken through the
 * real engine, because what is being proved is an *ordering* between the row a
 * person sees and the memory a worker keeps: the terminal row is published
 * first, and only then is anything released. A stub could be made to do either
 * order.
 */
describe("when builds end", () => {
  /** A profile with a model in it, so a build reaches the describing step. */
  const PROFILE: ModelProfile = {
    id: "mp_design",
    name: "Design",
    models: [{ provider: "fixture", id: "never-answers" }],
    origin: "person",
    updatedAt: "2026-02-03T10:00:00.000Z",
  };

  /**
   * The real index and the real workspace, wired as the worker wires them,
   * with every published row remembering whether the index still held that
   * build at the moment it was published.
   */
  function realWorkspace(projectCwd: string) {
    const published: Array<{ task: BackgroundTask; heldWhenPublished: boolean }> = [];
    let workspace!: DesignWorkspace;
    // A build that never gets an answer from its model: it is genuinely still
    // working, at the describing step, for as long as the test needs it.
    let hanging = false;
    const index = new ProjectDesignIndex({
      projectCwd,
      stateDir: join(projectCwd, ".state"),
      projectKey: "fixture",
      synthesis: () =>
        hanging
          ? {
              models: () => new Promise(() => {}),
              profile: PROFILE,
            }
          : undefined,
      onCommand: (command, owner) => workspace.observeCommand(command, owner),
      onProgress: (commandId, progress) => workspace.observeProgress(commandId, progress),
      onSettled: (command, owner, outcome) => workspace.observeSettled(command, owner, outcome),
    });
    workspace = new DesignWorkspace({
      projectCwd,
      index: () => index,
      grounding: () => ({}) as never,
      publishTask: (_path, task) => published.push({ task, heldWhenPublished: index.command(designCommandIdOf(task.id)) !== undefined }),
      holdsSession: () => true,
    });
    return {
      workspace,
      index,
      published,
      hang: (value: boolean) => {
        hanging = value;
      },
      rowsFor: (commandId: string) => published.filter((entry) => entry.task.id === designCommandTaskId(commandId)),
    };
  }

  /**
   * Wait until each of these builds has published a terminal row.
   *
   * The rows are what a person sees, and unlike a build they are never
   * forgotten — which is exactly what this waits for: a build past the bound
   * has been released, and asking the workspace about it would wait forever.
   */
  async function settledRows(rowsFor: (commandId: string) => Array<{ task: BackgroundTask }>, ids: readonly string[]): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const pending = ids.filter((id) => {
        const rows = rowsFor(id);
        const last = rows[rows.length - 1]?.task;
        return !last || last.status === "running";
      });
      if (pending.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("a build never published a terminal row");
  }

  it("bounds what it holds when a burst of builds all end and none follows", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace, index, hang, rowsFor } = realWorkspace(projectCwd);

    // One build that is still working while the others come and go.
    hang(true);
    const active = await workspace.build(buildParams());
    hang(false);

    const started = await Promise.all(Array.from({ length: 12 }, () => workspace.build(buildParams())));
    const ids = started.map((entry) => entry.command.commandId);
    await settledRows(rowsFor, ids);

    // Nothing is started after them: the sweep belongs to settlement, so the
    // closures of twelve finished builds are not held for the life of the
    // worker waiting for a thirteenth that may never come.
    const finished = index.commands().filter((command) => command.id !== active.command.commandId);
    expect(finished.length).toBe(FINISHED_COMMANDS_KEPT);

    // The build that is still working was never a candidate, however many
    // ended around it — and it still holds its running row.
    expect(index.command(active.command.commandId)).toBeDefined();
    const listed = (await workspace.get({ projectId: PROJECT_ID })).commands;
    expect(listed.find((command) => command.commandId === active.command.commandId)?.running).toBe(true);
    expect(rowsFor(active.command.commandId).every((entry) => entry.task.status === "running")).toBe(true);

    // And every build that ended told the fleet how it ended *before* anything
    // let go of it: no row was published after its own release.
    for (const id of ids) {
      const rows = rowsFor(id);
      const last = rows[rows.length - 1];
      expect(last, id).toBeDefined();
      expect(last?.task.status, id).not.toBe("running");
      expect(last?.task.endedAt, id).toBeDefined();
      expect(last?.heldWhenPublished, id).toBe(true);
    }

    // Leave nothing waiting on a model that will never answer.
    workspace.stop({ projectId: PROJECT_ID, commandId: active.command.commandId });
  });

  /**
   * Stopped, but by what?
   *
   * A fleet row's last word is read as a statement about the person's own
   * doing. "You stopped it" about a build that ran into a bound this app set
   * for it is simply false, so the row says which of the two it was, from the
   * engine's own answer rather than from the fact that it ended early.
   */
  it("never tells a person they stopped a build that ran into its own budget", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace, rowsFor } = realWorkspace(projectCwd);

    const { command } = await workspace.build(buildParams({ maxFiles: 1 }));
    await settledRows(rowsFor, [command.commandId]);

    const last = rowsFor(command.commandId).at(-1)?.task;
    expect(last?.status).toBe("stopped");
    expect(last?.terminalReason, "nobody stopped this build").not.toBe("you stopped it");
    expect(last?.terminalReason ?? "").toMatch(/budget/);
    expect(last?.error, "a bound is not a failure").toBeUndefined();
  });

  /**
   * A build that really fails, at the place a build really can: the write at
   * the end. The index file's own path is a directory here, so the rename the
   * store does cannot land.
   *
   * The phase a progress report carries is not the outcome: `failed` can be
   * seen before the error is in hand, and a row that trusted the phase alone
   * would have to guess — and would guess *completed*, right before the
   * failure arrived.
   */
  it("never says a failing build completed, and its last word is the failure", async () => {
    const projectCwd = copyFixture("react-tailwind");
    mkdirSync(indexPath(projectCwd), { recursive: true });
    const { workspace, published, rowsFor } = realWorkspace(projectCwd);

    const { command } = await workspace.build(buildParams());
    await waitForCommand(workspace, command.commandId);

    const rows = rowsFor(command.commandId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((entry) => entry.task.status)).not.toContain("completed");
    const last = rows[rows.length - 1];
    expect(last?.task.status).toBe("failed");
    expect(last?.task.error ?? "").toMatch(/index/i);
    expect(last?.task.terminalReason).toBe(last?.task.error);
    expect(last?.task.endedAt).toBeDefined();
    // Published while the build was still held: the correct row cannot be lost
    // to a sweep that got there first.
    expect(last?.heldWhenPublished).toBe(true);
    expect(published.every((entry) => entry.task.status !== "stopped")).toBe(true);

    // The window reads the same one outcome.
    const listed = (await workspace.get({ projectId: PROJECT_ID })).commands.find((entry) => entry.commandId === command.commandId);
    expect(listed?.running).toBe(false);
    expect(listed?.phase).toBe("failed");
    expect(listed?.failure ?? "").toMatch(/index/i);
  });

  /**
   * The phase is not the outcome.
   *
   * A progress report can carry a terminal-looking phase while the build has
   * not been answered for: `failed` before the error is in hand, `done` before
   * the write that could still fail. A row published from the phase alone has
   * to guess which of the three terminals it is — and the guess is
   * *completed*, which is the one thing it must never say wrongly. So a build
   * stays running until its outcome arrives, and the outcome writes the row.
   */
  it("publishes no terminal row until the outcome is known, whatever phase was reported", () => {
    const published: BackgroundTask[] = [];
    const workspace = new DesignWorkspace({
      projectCwd: "/project",
      index: () => ({ index: async () => undefined, command: () => undefined, stop: () => false }) as never,
      grounding: () => ({}) as never,
      publishTask: (_path, task) => published.push(task),
      holdsSession: () => true,
    });
    const fake = (id: string): DesignBuildCommand =>
      ({
        id,
        title: `Build ${id}`,
        progress: () => ({ phase: "scanning", filesParsed: 0, filesFound: 0, filesFromCache: 0, elapsedMs: 0 }),
        stop: () => {},
        // Nothing settles it here: the outcome is announced explicitly, which
        // is the ordering the index guarantees.
        done: new Promise<DesignBuildResult>(() => {}),
      }) as unknown as DesignBuildCommand;
    const owner = { sessionPath: SESSION };
    const rowsOf = (id: string) => published.filter((task) => task.id === designCommandTaskId(id));

    const failing = fake("cmd-failing");
    workspace.observeCommand(failing, owner);
    workspace.observeProgress(failing.id, { phase: "failed", filesParsed: 9, filesFound: 9, filesFromCache: 0, elapsedMs: 40 });
    expect(rowsOf(failing.id).map((task) => task.status)).toEqual(["running", "running"]);
    expect(rowsOf(failing.id).every((task) => task.endedAt === undefined)).toBe(true);

    const done = fake("cmd-writing");
    workspace.observeCommand(done, owner);
    workspace.observeProgress(done.id, { phase: "done", filesParsed: 9, filesFound: 9, filesFromCache: 0, elapsedMs: 40 });
    expect(rowsOf(done.id).every((task) => task.status === "running")).toBe(true);

    // The outcomes arrive, and they are what the rows say.
    workspace.observeSettled(failing, owner, {
      kind: "failed",
      error: new DesignStorageRefused("invalid_index", "This index does not match the shape a stored index has.", "build the index again"),
    });
    const failed = rowsOf(failing.id).at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("This index does not match the shape a stored index has. Next: build the index again.");
    expect(failed?.terminalReason).toBe(failed?.error);

    workspace.observeSettled(done, owner, {
      kind: "done",
      result: { progress: { phase: "done", filesParsed: 9, filesFound: 9, filesFromCache: 0, elapsedMs: 41 }, stopped: false } as unknown as DesignBuildResult,
    });
    expect(rowsOf(done.id).at(-1)?.status).toBe("completed");
    expect(rowsOf(failing.id).some((task) => task.status === "completed")).toBe(false);
  });
});

describe("design/index/review", () => {
  it("persists a decision into review.json and answers the whole reviewed index", async () => {
    const projectCwd = copyFixture("react-tailwind");
    const { workspace } = workspaceFor(projectCwd);
    const { command } = await workspace.build(buildParams());
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
    const { command } = await workspace.build(buildParams());
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
    const { command } = await workspace.build(buildParams());
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
    const { command } = await workspace.build(buildParams());
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
    const { command } = await workspace.build(buildParams());
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
