/**
 * The design workspace, as the window asks for it (M21-T13).
 *
 * The six `design/*` methods the host forwards land here, on top of the two
 * engines that already exist: `ProjectDesignIndex` (M21-T10) owns the index,
 * its review and its builds; `ProjectHostGrounding` (M21-T12) grounds a page.
 * This module is the seam between a protocol shape and those engines, and it
 * holds three things neither of them should:
 *
 * 1. **The Command a person can see, and the one admission that mints it.**
 *    An index build is published as a background Command row — title, progress
 *    *by files*, stop — under the session that owns it (D-328: one command,
 *    one session). Every build in this worker is admitted here, the person's
 *    through `design/index/build` and the model's through the session-bound
 *    bridge behind `build_design_index`, so there is one place that decides
 *    whether a build may start and exactly one that names its owner. A build
 *    with no owning session, or one naming a session this worker does not
 *    hold, is refused before a file is opened: invisible work is not a build
 *    with a missing row, it is a build that must not start.
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
import type { DesignBuildOutcome, ProjectDesignIndex } from "./index/bridge.js";
import { progressLine, type DesignBuildCommand, type DesignBuildProgress } from "./index/command.js";
import type { DesignBuildOwner } from "./index/tools.js";
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

/**
 * A build refused before anything ran.
 *
 * Thrown by the admission and rendered by both its faces: as a
 * `ProtocolError` for the window, and — because it carries `code` and `next` —
 * as an ordinary tool refusal for the model, through the design tools' own
 * `asToolFailure`. Nothing has been written, no cache cleared and no file
 * opened when it is thrown.
 */
export class DesignBuildRefused extends Error {
  readonly code: string;
  readonly next: string;
  constructor(code: string, message: string, next: string) {
    super(message);
    this.name = "DesignBuildRefused";
    this.code = code;
    this.next = next;
  }
}

export const DESIGN_BUILD_NO_SESSION_SENTENCE =
  "An index build runs as a Command in a conversation, so it can be watched and stopped there. This one was asked for without one, so nothing was started.";

export const DESIGN_BUILD_UNKNOWN_SESSION_SENTENCE =
  "That conversation is not open in this project, so a build started for it would run where nobody could see or stop it. Nothing was started.";

/**
 * How a build ended, in the one vocabulary a fleet row and the window share.
 *
 * Set once, at settlement, from the engine's own answer — never inferred from
 * a phase. While it is absent the build is running, whatever a progress report
 * has said: a build is not over until the engine says how it ended, and a row
 * that guessed *completed* from a phase could contradict the failure that
 * arrives a microtask later.
 */
interface Settled {
  status: "completed" | "failed" | "stopped";
  /** Why it failed, as a sentence. Only ever set with `status: "failed"`. */
  failure?: string;
  /**
   * What ended it early, when something did. Only ever set with
   * `status: "stopped"`, and only when the engine said which it was: a row
   * must not tell a person they stopped a build that ran into its own budget.
   */
  stoppedBy?: "person" | "budget";
}

/**
 * The last word on a build that did not run to its end.
 *
 * Three sentences, because there are three truths: the person stopped it, the
 * build reached a bound this app set for it, or it ended early and this worker
 * cannot say which — which is said as little as it knows rather than guessed
 * into the person's own words.
 */
function stoppedReason(by: Settled["stoppedBy"]): string {
  if (by === "person") return "you stopped it";
  if (by === "budget") return "it reached its budget before the end";
  return "it ended before the end";
}

interface Tracked {
  command: DesignBuildCommand;
  progress: DesignBuildProgress;
  /**
   * Where the owning conversation lives.
   *
   * *Who* owns the build is fixed at admission and never re-read from whatever
   * conversation is current. This is that conversation's **address**, and the
   * one thing about it that can change: a fork moves a session's file, and
   * `rekeySession` moves this with it so the row keeps naming the session that
   * is really there.
   */
  sessionPath: string;
  startedAt: string;
  /** Absent while it runs; the one coherent outcome once it has ended. */
  settled?: Settled;
  /** When the row was last published, so a per-file report is not a per-file frame. */
  publishedAtMs: number;
  publishedPhase?: DesignBuildProgress["phase"];
}

/**
 * Why a build failed, for a person reading a fleet row.
 *
 * A refusal from below (storage, review) already carries a sentence and what
 * to do next; anything else — a filesystem error, a bug — is given the
 * sentence it lacks rather than being shown raw.
 */
function failureSentence(error: unknown): string {
  const known = error as { message?: unknown; next?: unknown } | null;
  const message = typeof known?.message === "string" ? known.message.trim() : "";
  const next = typeof known?.next === "string" && known.next.trim() !== "" ? ` Next: ${known.next.trim()}.` : "";
  if (message === "") return "The index build stopped on an error, so the index was not written. Try building it again.";
  // A refusal that wrote its own sentence is shown as it is; a raw error
  // message is given one, so a row never reads as a stack trace.
  const sentence = next !== "" || /[.!?]$/.test(message) ? message : `The index build could not finish: ${message}`;
  return boundedSentence(`${sentence}${next}`);
}

/** The longest failure sentence a fleet row carries. */
const FAILURE_SENTENCE_MAX = 500;

/**
 * The same sentence, short enough for a row, cut where a reader would cut it.
 *
 * A hard slice can end mid-word, which reads as a rendering bug rather than as
 * a long message; backing up to the last space keeps it a sentence. The backup
 * is bounded too — a "word" longer than a quarter of the budget (a path, a
 * digest) is cut where it is rather than losing most of the sentence.
 */
function boundedSentence(sentence: string): string {
  if (sentence.length <= FAILURE_SENTENCE_MAX) return sentence;
  const cut = sentence.slice(0, FAILURE_SENTENCE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  const kept = space >= FAILURE_SENTENCE_MAX * 0.75 ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}\u2026`;
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
  /**
   * Whether this worker holds that conversation open right now.
   *
   * The worker only ever opens sessions of its own project — `session/new`
   * and `session/load` refuse any other directory, and a child session is
   * opened by the harness in a worktree of this project — so "this worker
   * holds it" *is* "it belongs to this project". Absent in narrow tests, where
   * the fixture is the authority on who exists.
   */
  holdsSession?: (sessionPath: string) => boolean;
  now?: () => number;
}

export class DesignWorkspace {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly options: DesignWorkspaceOptions) {}

  /**
   * A build has started. Called by the index bridge the moment the command
   * exists — which is while the build is still at its first await, so the
   * first row a person sees is a running one, not a summary of something that
   * already happened.
   *
   * The owner arrives with the command rather than being read from a field the
   * caller set a moment ago: concurrent admissions cannot interleave into each
   * other's row.
   */
  observeCommand(command: DesignBuildCommand, owner: DesignBuildOwner): void {
    const held: Tracked = {
      command,
      progress: command.progress(),
      sessionPath: owner.sessionPath,
      startedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      publishedAtMs: 0,
    };
    this.tracked.set(command.id, held);
    this.publish(command.id, true);
    this.prune();
  }

  /**
   * A fork moved the owning conversation's file: the rows follow it.
   *
   * The logical owner does not change — the same conversation still owns the
   * same builds, and nothing here reads the current conversation. What changes
   * is the *address* the rows are published under, for active and finished
   * builds alike, so `design/index/get` and the fleet keep agreeing with the
   * worker's own task index (which the server moves in the same step).
   *
   * A build that is still running republishes its row at once: a row is only
   * ever learned from a publication, so a build that reports nothing for a
   * while would otherwise be missing from the conversation that now exists
   * until it ends. Nothing about the row changes but the session it hangs
   * under.
   */
  rekeySession(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const moved: string[] = [];
    for (const [commandId, held] of this.tracked) {
      if (held.sessionPath !== oldPath) continue;
      held.sessionPath = newPath;
      if (this.isRunning(held)) moved.push(commandId);
    }
    for (const commandId of moved) this.publish(commandId, true);
  }

  /** One progress report from the engine. Files, never a percentage. */
  observeProgress(commandId: string, progress: DesignBuildProgress): void {
    const held = this.tracked.get(commandId);
    if (!held) return;
    held.progress = progress;
    this.publish(commandId, progress.phase !== held.publishedPhase);
  }

  /**
   * A build has ended, and this is how. Called by the index the moment its
   * `done` settles and **before** it releases anything, so the row that says
   * *failed*, *stopped* or *completed* is published while the build is still
   * held by everyone who could be asked about it.
   *
   * One outcome, from the engine's own answer: a progress report can say
   * `failed` before the error is in hand, and a row built from that alone
   * would have to guess — and would guess *completed*. Nothing guesses here.
   */
  observeSettled(command: DesignBuildCommand, owner: DesignBuildOwner, outcome: DesignBuildOutcome): void {
    const held = this.tracked.get(command.id);
    if (!held || held.settled !== undefined) return;
    if (outcome.kind === "failed") {
      held.progress = { ...held.progress, phase: "failed" };
      held.settled = { status: "failed", failure: failureSentence(outcome.error) };
    } else {
      held.progress = outcome.result.progress;
      const stopped = outcome.result.stopped === true || outcome.result.progress.phase === "stopped";
      const by = outcome.result.stoppedBy;
      held.settled = { status: stopped ? "stopped" : "completed", ...(stopped && by !== undefined ? { stoppedBy: by } : {}) };
    }
    // The final row first, then the bookkeeping: a person watching the fleet
    // sees this build end before anything older is forgotten.
    this.publish(command.id, true);
    this.prune();
  }

  async get(_params: Params<"design/index/get">): Promise<Answer<"design/index/get">> {
    const index = await this.options.index().index();
    const commands = [...this.tracked.values()].map((held) => this.commandOf(held));
    if (!index) return { state: "absent", commands, detail: DESIGN_INDEX_ABSENT_SENTENCE };
    const progress = reviewProgress(index);
    return { state: "ready", index, progress, commands };
  }

  /**
   * `design/index/build`: the person's face of the one admission.
   *
   * A refusal is a sentence with what to do next, because the window shows it
   * where the button was.
   */
  async build(params: Params<"design/index/build">): Promise<Answer<"design/index/build">> {
    try {
      const started = await this.startBuild({
        sessionPath: params.sessionPath,
        rebuild: params.rebuild === true,
        ...(params.appRoot !== undefined ? { appRoot: params.appRoot } : {}),
        ...(params.maxFiles !== undefined ? { maxFiles: params.maxFiles } : {}),
      });
      return { command: started.command };
    } catch (error) {
      if (error instanceof DesignBuildRefused) {
        throw new ProtocolError(ErrorCodes.InvalidParams, `${error.message} Next: ${error.next}.`, { code: error.code, next: error.next });
      }
      throw error;
    }
  }

  /**
   * The one admission every index build in this worker goes through.
   *
   * The owner is decided *here*, before the engine is asked for anything: a
   * build that cannot be owned is never started, so there is no such thing as
   * a build running without a row. Everything after this point — the engine,
   * the row, the retention, Stop — reads the owner this returned.
   */
  async startBuild(input: { sessionPath: string; rebuild?: boolean; appRoot?: string; maxFiles?: number }): Promise<{ command: DesignIndexCommand; appRoot: string }> {
    const owner = this.ownerOf(input.sessionPath);
    const started = await this.options.index().startBuild({
      owner,
      rebuild: input.rebuild === true,
      ...(input.appRoot !== undefined ? { appRoot: input.appRoot } : {}),
      ...(input.maxFiles !== undefined ? { maxFiles: input.maxFiles } : {}),
    });
    const command = this.options.index().command(started.commandId);
    const held = this.tracked.get(started.commandId);
    if (!command || !held) {
      throw new ProtocolError(ErrorCodes.Internal, "The index build could not be started. Try again; nothing was written.");
    }
    // Nothing is attached to `command.done` here: how a build ended reaches
    // this workspace through the index's `onSettled`, which runs before the
    // index releases the build and before any caller's own continuation. A
    // second handler registered at this point would run *after* both, and the
    // last row would be a race.
    return { command: this.commandOf(held), appRoot: started.appRoot };
  }

  /**
   * Who owns this build, or why nobody may.
   *
   * Two refusals, both before any work: no session at all, and a session this
   * worker does not hold — which covers a conversation that has been closed, a
   * path that never existed and a session of another project alike, because a
   * worker holds only its own project's sessions.
   */
  private ownerOf(sessionPath: string | undefined): DesignBuildOwner {
    const path = sessionPath?.trim();
    if (path === undefined || path === "") {
      throw new DesignBuildRefused(
        "no_owning_session",
        DESIGN_BUILD_NO_SESSION_SENTENCE,
        "start the build from a conversation in this project, so its Command has somewhere to show",
      );
    }
    if (this.options.holdsSession && !this.options.holdsSession(path)) {
      throw new DesignBuildRefused(
        "unknown_session",
        DESIGN_BUILD_UNKNOWN_SESSION_SENTENCE,
        "open a conversation in this project and start the build from there",
      );
    }
    return { sessionPath: path };
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

  /**
   * True while this build can still do something.
   *
   * The settled outcome, and nothing else: a build whose last progress report
   * said `done` has still not been answered for — it can still fail while
   * writing — and one that said `failed` has no failure to show yet. Waiting
   * for the outcome is what makes the terminal row true, and it is also what
   * keeps a build that has not published its last row from being pruned.
   */
  private isRunning(held: Tracked): boolean {
    return held.settled === undefined;
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
      ...(held.settled?.failure !== undefined ? { failure: held.settled.failure } : {}),
      sessionPath: held.sessionPath,
    };
  }

  /** The fleet row for one build, in the vocabulary a Command row already has. */
  private publish(commandId: string, force = false): void {
    const held = this.tracked.get(commandId);
    if (!held || !this.options.publishTask) return;
    const at = this.options.now?.() ?? Date.now();
    if (!force && at - held.publishedAtMs < ROW_INTERVAL_MS) return;
    held.publishedAtMs = at;
    held.publishedPhase = held.progress.phase;
    // One outcome decides the row: the status it carries, the reason it gives
    // and whether it has an end at all all come from the same value, so a row
    // can never say *completed* about a build that failed.
    const settled = held.settled;
    const task: BackgroundTask = {
      id: designCommandTaskId(commandId),
      sessionPath: held.sessionPath,
      command: `Index the design system of ${this.options.projectCwd}`,
      title: held.command.title,
      status: settled?.status ?? "running",
      origin: "background",
      startedAt: held.startedAt,
      outputBytes: 0,
      activity: progressLine(held.progress),
      ...(settled === undefined ? {} : { endedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), exitCode: null }),
      ...(settled?.failure !== undefined ? { error: settled.failure, terminalReason: settled.failure } : {}),
      ...(settled?.status === "stopped" ? { terminalReason: stoppedReason(settled.stoppedBy) } : {}),
      ...(settled?.status === "completed" ? { terminalReason: progressLine(held.progress) } : {}),
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
