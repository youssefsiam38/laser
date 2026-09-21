/**
 * The design workspace, as the window asks for it (M21-T13).
 *
 * The six `design/*` methods the host forwards land here, on top of the two
 * engines that already exist: `ProjectDesignIndex` (M21-T10) owns the index,
 * its review and its builds; `ProjectHostGrounding` (M21-T12) grounds a page.
 * This module is the seam between a protocol shape and those engines, and it
 * holds three things neither of them should:
 *
 * 1. **The Command a person can see.** An index build is published as a
 *    background Command row — title, progress *by files*, stop — under the
 *    session the person started it from (D-328: one command, one session).
 *    The engine stays a library; the fleet row is a message this module emits.
 * 2. **The bounded reference image.** A repository screenshot is carried to
 *    the window once, with its bytes, so a region can be drawn on it. It is
 *    never read for text, and a person-supplied image never travels this way.
 * 3. **The refusals, in sentences.** A review refused by the engine, a route
 *    that resolves to nothing, a sketch that cannot be rebuilt: each answers
 *    with what happened and what to do next, never a code alone.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_INDEX_ABSENT_SENTENCE,
  DESIGN_REFERENCE_IMAGE_MAX_BYTES,
  ErrorCodes,
  ProtocolError,
  type BackgroundTask,
  type ClientRequests,
  type DesignIndexCommand,
  type DesignStrategyProposal,
} from "@lasercode/protocol";
import type { ProjectDesignIndex } from "./index/bridge.js";
import { progressLine, type DesignBuildCommand, type DesignBuildProgress } from "./index/command.js";
import { reviewProgress, ReviewRefused } from "./index/review.js";
import type { ProjectHostGrounding } from "./host/ground.js";
import type { StrategyProposal } from "./host/strategy.js";
import { groundSketch, GroundSketchRefused } from "./sketch/ground.js";

type Params<M extends keyof ClientRequests> = ClientRequests[M]["params"];
type Answer<M extends keyof ClientRequests> = ClientRequests[M]["result"];

/** The id an index build takes in the fleet. Namespaced so it can never
 * collide with a shell command's id, and readable in a log. */
export function designCommandTaskId(commandId: string): string {
  return `design-index-${commandId}`;
}

/** True for a task id this module minted, so Stop from the fleet finds it. */
export function isDesignCommandTaskId(id: string): boolean {
  return id.startsWith("design-index-");
}

export function designCommandIdOf(taskId: string): string {
  return taskId.slice("design-index-".length);
}

interface Tracked {
  command: DesignBuildCommand;
  progress: DesignBuildProgress;
  sessionPath?: string;
  startedAt: string;
  running: boolean;
  failure?: string;
  /** When the row was last published, so a per-file report is not a per-file frame. */
  publishedAtMs: number;
  publishedPhase?: DesignBuildProgress["phase"];
}

/** How often a running build refreshes its fleet row. A file is not a frame. */
const ROW_INTERVAL_MS = 250;

/**
 * How many *finished* builds this worker keeps.
 *
 * A build that has ended is history: `design/index/get` shows the recent ones
 * so a person can see what the last index build did, and a project that
 * re-indexes all day must not grow a row per build for the life of the
 * worker. A running build is never counted and never evicted, and a build's
 * last row is published before it can be pruned, so the fleet never loses the
 * final state of something it showed as running.
 */
const FINISHED_BUILDS_KEPT = 8;

export interface DesignWorkspaceOptions {
  projectCwd: string;
  index: () => ProjectDesignIndex;
  grounding: () => ProjectHostGrounding;
  /** Publish one fleet row. Absent in narrow tests. */
  publishTask?: (sessionPath: string, task: BackgroundTask) => void;
  now?: () => number;
}

export class DesignWorkspace {
  private readonly tracked = new Map<string, Tracked>();
  /** The session the build being started belongs to, until its command exists. */
  private startingFor: string | undefined;

  constructor(private readonly options: DesignWorkspaceOptions) {}

  /**
   * A build has started. Called by the index bridge the moment the command
   * exists — which is while the build is still at its first await, so the
   * first row a person sees is a running one, not a summary of something that
   * already happened.
   */
  observeCommand(command: DesignBuildCommand): void {
    const held: Tracked = {
      command,
      progress: command.progress(),
      ...(this.startingFor !== undefined ? { sessionPath: this.startingFor } : {}),
      startedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      running: true,
      publishedAtMs: 0,
    };
    this.tracked.set(command.id, held);
    this.publish(command.id, true);
    this.prune();
  }

  /** One progress report from the engine. Files, never a percentage. */
  observeProgress(commandId: string, progress: DesignBuildProgress): void {
    const held = this.tracked.get(commandId);
    if (!held) return;
    held.progress = progress;
    this.publish(commandId, progress.phase !== held.publishedPhase);
  }

  async get(_params: Params<"design/index/get">): Promise<Answer<"design/index/get">> {
    const index = await this.options.index().index();
    const commands = [...this.tracked.values()].map((held) => this.commandOf(held));
    if (!index) return { state: "absent", commands, detail: DESIGN_INDEX_ABSENT_SENTENCE };
    const progress = reviewProgress(index);
    return { state: "ready", index, progress, commands };
  }

  async build(params: Params<"design/index/build">): Promise<Answer<"design/index/build">> {
    this.startingFor = params.sessionPath;
    let started: { commandId: string };
    try {
      started = await this.options.index().startBuild({
        rebuild: params.rebuild === true,
        ...(params.appRoot !== undefined ? { appRoot: params.appRoot } : {}),
        ...(params.maxFiles !== undefined ? { maxFiles: params.maxFiles } : {}),
      });
    } finally {
      this.startingFor = undefined;
    }
    const command = this.options.index().command(started.commandId);
    const held = this.tracked.get(started.commandId);
    if (!command || !held) {
      throw new ProtocolError(ErrorCodes.Internal, "The index build could not be started. Try again; nothing was written.");
    }
    void command.done
      .then((result) => {
        held.progress = result.progress;
        held.running = false;
      })
      .catch((error: unknown) => {
        held.running = false;
        held.failure = error instanceof Error ? error.message.slice(0, 500) : "The index build failed.";
        held.progress = { ...held.progress, phase: "failed" };
      })
      .finally(() => {
        // The final row first, then the bookkeeping: a person watching the
        // fleet sees this build end before anything older is forgotten.
        this.publish(started.commandId, true);
        this.prune();
      });
    return { command: this.commandOf(held) };
  }

  stop(params: Params<"design/index/stop">): Answer<"design/index/stop"> {
    const held = this.tracked.get(params.commandId);
    const stopped = this.options.index().stop(params.commandId);
    if (!held) return { stopped };
    held.command.stop();
    this.publish(params.commandId, true);
    return { stopped: true, command: this.commandOf(held) };
  }

  /** Stop from the fleet's own row. Answers whether this worker had it. */
  stopByTaskId(taskId: string): boolean {
    if (!isDesignCommandTaskId(taskId)) return false;
    const commandId = designCommandIdOf(taskId);
    if (!this.tracked.has(commandId)) return false;
    this.stop({ projectId: "", commandId });
    return true;
  }

  async review(params: Params<"design/index/review">, actor: { kind: "person" | "agent"; label: string }): Promise<Answer<"design/index/review">> {
    try {
      await this.options.index().review({
        entryId: params.entryId,
        action: params.action,
        actor,
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.intoEntryId !== undefined ? { intoEntryId: params.intoEntryId } : {}),
        ...(params.note !== undefined ? { note: params.note } : {}),
        ...(params.useForNewWork !== undefined ? { useForNewWork: params.useForNewWork } : {}),
        ...(params.expectedFactsDigest !== undefined ? { expectedFactsDigest: params.expectedFactsDigest } : {}),
      });
    } catch (error) {
      if (error instanceof ReviewRefused) {
        throw new ProtocolError(ErrorCodes.InvalidParams, `${error.message} Next: ${error.next}.`, { code: error.code, next: error.next });
      }
      throw error;
    }
    const index = await this.options.index().index();
    if (!index) throw new ProtocolError(ErrorCodes.InvalidParams, DESIGN_INDEX_ABSENT_SENTENCE);
    return { index, progress: reviewProgress(index) };
  }

  async ground(params: Params<"design/host/ground">): Promise<Answer<"design/host/ground">> {
    const result = await this.options.grounding().ground({
      routeOrPath: params.routeOrPath,
      ...(params.appRoot !== undefined ? { appRoot: params.appRoot } : {}),
      ...(params.featureSize !== undefined ? { featureSize: params.featureSize } : {}),
      ...(params.hostStackCanExpress !== undefined ? { hostStackCanExpress: params.hostStackCanExpress } : {}),
      ...(params.migrationWanted !== undefined ? { migrationWanted: params.migrationWanted } : {}),
      ...(params.teamKnowsHostStack !== undefined ? { teamKnowsHostStack: params.teamKnowsHostStack } : {}),
    });
    const gaps = result.gaps.slice(0, 50).map((gap) => ({ path: gap.path.slice(0, 1024), reason: gap.reason.slice(0, 500) }));
    if (!result.hostPage) {
      return {
        candidates: result.candidates.slice(0, 50),
        gaps,
        detail:
          result.candidates.length > 0
            ? `No page in this project answers to "${params.routeOrPath}". These look close; pick one and ground that.`
            : `No page in this project answers to "${params.routeOrPath}". Name the template file instead of the route, or check the app root.`,
      };
    }
    const referenceImage = this.referenceImageOf(result.hostPage.references, params.appRoot);
    return {
      hostPage: result.hostPage,
      ...(result.strategy !== undefined ? { strategy: toStrategyProposal(result.strategy) } : {}),
      candidates: [],
      gaps,
      ...(referenceImage !== undefined ? { referenceImage } : {}),
    };
  }

  async groundSketchDocument(params: Params<"design/sketch/ground">): Promise<Answer<"design/sketch/ground">> {
    const index = await this.options.index().index();
    try {
      return groundSketch({
        document: params.document,
        ...(index !== undefined ? { index } : {}),
        ...(params.screenName !== undefined ? { screenName: params.screenName } : {}),
        ...(params.eraId !== undefined ? { eraId: params.eraId } : {}),
        screenId: `gs${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      });
    } catch (error) {
      if (error instanceof GroundSketchRefused) {
        throw new ProtocolError(ErrorCodes.InvalidParams, `${error.message} Next: ${error.next}.`, { next: error.next });
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------- inside

  /** True while this build can still do something. Phase, not just the flag. */
  private isRunning(held: Tracked): boolean {
    const phase = held.progress.phase;
    return held.running && phase !== "done" && phase !== "stopped" && phase !== "failed";
  }

  /**
   * Forget the oldest finished builds past the retention.
   *
   * Insertion order is start order, so the oldest finished build goes first.
   * Nothing that is still running is a candidate, whatever the retention is,
   * and a build that is forgotten here has already published its last row.
   */
  private prune(): void {
    const finished = [...this.tracked.entries()].filter(([, held]) => !this.isRunning(held));
    for (let index = 0; index < finished.length - FINISHED_BUILDS_KEPT; index += 1) {
      this.tracked.delete(finished[index]![0]);
    }
  }

  private commandOf(held: Tracked): DesignIndexCommand {
    const progress = held.progress;
    return {
      commandId: held.command.id,
      title: held.command.title,
      phase: progress.phase,
      filesParsed: progress.filesParsed,
      filesFound: progress.filesFound,
      filesFromCache: progress.filesFromCache,
      ...(progress.currentPath !== undefined ? { currentPath: progress.currentPath } : {}),
      elapsedMs: Math.max(0, Math.round(progress.elapsedMs)),
      running: this.isRunning(held),
      ...(held.failure !== undefined ? { failure: held.failure } : {}),
      ...(held.sessionPath !== undefined ? { sessionPath: held.sessionPath } : {}),
    };
  }

  /** The fleet row for one build, in the vocabulary a Command row already has. */
  private publish(commandId: string, force = false): void {
    const held = this.tracked.get(commandId);
    if (!held || held.sessionPath === undefined || !this.options.publishTask) return;
    const at = this.options.now?.() ?? Date.now();
    if (!force && at - held.publishedAtMs < ROW_INTERVAL_MS) return;
    held.publishedAtMs = at;
    held.publishedPhase = held.progress.phase;
    const command = this.commandOf(held);
    const task: BackgroundTask = {
      id: designCommandTaskId(commandId),
      sessionPath: held.sessionPath,
      command: `Index the design system of ${this.options.projectCwd}`,
      title: held.command.title,
      status: command.running ? "running" : command.failure !== undefined ? "failed" : command.phase === "stopped" ? "stopped" : "completed",
      origin: "background",
      startedAt: held.startedAt,
      outputBytes: 0,
      activity: progressLine(held.progress),
      ...(command.running ? {} : { endedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), exitCode: null }),
      ...(command.failure !== undefined ? { error: command.failure, terminalReason: command.failure } : {}),
      ...(!command.running && command.phase === "stopped" ? { terminalReason: "you stopped it" } : {}),
      ...(!command.running && command.phase === "done" ? { terminalReason: progressLine(held.progress) } : {}),
    };
    this.options.publishTask(held.sessionPath, task);
  }

  /**
   * The first repository reference image, with its bytes.
   *
   * Bounded and typed by its own path: it is a picture to lay a design over,
   * and nothing reads it for content. A person-supplied screenshot is a blob
   * on the revision and never crosses here (`docs/design-phase.md`,
   * "Security").
   */
  private referenceImageOf(
    references: ReadonlyArray<{ kind: string; path?: string; mediaType?: string }> | undefined,
    appRoot: string | undefined,
  ): Answer<"design/host/ground">["referenceImage"] {
    const reference = references?.find((candidate) => candidate.kind === "repository" && candidate.path !== undefined);
    const relative = reference?.path;
    if (relative === undefined) return undefined;
    const root = appRoot === undefined || appRoot === "." ? this.options.projectCwd : join(this.options.projectCwd, appRoot);
    const path = join(root, relative);
    try {
      if (statSync(path).size > DESIGN_REFERENCE_IMAGE_MAX_BYTES) return undefined;
      const bytes = readFileSync(path);
      return {
        path: relative,
        mediaType: reference?.mediaType ?? "image/png",
        bytes: bytes.byteLength,
        data: bytes.toString("base64"),
      };
    } catch {
      // A reference the repository names but this machine cannot read is not
      // an error: the outline is the host, and the picture was only a help.
      return undefined;
    }
  }
}

/** The strategy proposal, as the wire shape rather than the engine's. */
export function toStrategyProposal(proposal: StrategyProposal): DesignStrategyProposal {
  const caseOf = (value: StrategyProposal["conform"]): DesignStrategyProposal["conform"] => ({
    kind: value.kind,
    reasons: value.reasons.slice(0, 16).map((reason) => reason.slice(0, 2000)),
    tradeoffs: value.tradeoffs.slice(0, 16).map((tradeoff) => tradeoff.slice(0, 2000)),
    ...(value.eraId !== undefined ? { eraId: value.eraId } : {}),
  });
  return {
    recommended: proposal.recommended,
    conform: caseOf(proposal.conform),
    island: caseOf(proposal.island),
    summary: proposal.summary.slice(0, 2000),
    proposalOnly: proposal.proposalOnly,
    ...(proposal.newWorkEra !== undefined ? { newWorkEra: { id: proposal.newWorkEra.id, name: proposal.newWorkEra.name } } : {}),
  };
}
