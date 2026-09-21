/**
 * The real bridge behind the three tools: one project's index, its review and
 * its builds.
 *
 * It is the only place that holds a build in flight, so a tool call returns
 * the command id immediately and the person can stop the command from the
 * fleet (`docs/design-phase.md`, "Re-index"). Everything it writes goes
 * through `storage.ts`, which is the project-config path.
 */
import type { DesignIndex, DesignIndexEntry } from "@lasercode/protocol";
import {
  startDesignIndexBuild,
  type DesignBuildCommand,
  type DesignBuildOptions,
  type DesignBuildProgress,
  type DesignBuildResult,
} from "./command.js";
import type { DesignBuildOwner } from "./tools.js";
import { applyReview, applyReviewAction, reviewProgress, ReviewRefused, type ReviewActor, type DesignReviewAction } from "./review.js";
import { clearParseCache, fileParseCache, readIndex, readReview, writeIndex, writeReview, type ParseCache } from "./storage.js";


export interface ProjectDesignIndexOptions {
  projectCwd: string;
  /** Laser's own state directory, where the digest-keyed parse cache lives. */
  stateDir: string;
  /** Stable key for this project inside the state directory. */
  projectKey: string;
  /**
   * Synthesis, read once per build rather than once per worker: the profile
   * design work runs on is a setting, and a person who assigns one while this
   * project is open must not have to restart anything for the next build to
   * use it.
   */
  synthesis?: () => DesignBuildOptions["synthesis"] | undefined;
  /**
   * Told about every build and the session that owns it, so the fleet can show
   * it. The owner is an argument, never a field read afterwards: two sessions
   * starting builds at once must not be able to take each other's.
   */
  onCommand?: (command: DesignBuildCommand, owner: DesignBuildOwner) => void;
  onProgress?: (commandId: string, progress: DesignBuildProgress) => void;
  /**
   * Told how a build ended, **while it is still held**.
   *
   * This is the ordering the retention below depends on: whoever publishes a
   * build's last row is called from here, and nothing is released until that
   * call has returned. A caller that attaches its own handler to
   * `command.done` instead would race this one, because handler order is
   * registration order and the index registers first.
   */
  onSettled?: (command: DesignBuildCommand, owner: DesignBuildOwner, outcome: DesignBuildOutcome) => void;
  now?: () => number;
}

/**
 * How one build ended, as the index learned it from the engine.
 *
 * One value, decided once: a build either has a result — which says whether it
 * ran to the end or was stopped — or it failed with an error. Nothing infers
 * an outcome from a phase that happens to have been reported, so a terminal
 * row can never say one thing and the failure another.
 */
export type DesignBuildOutcome = { kind: "done"; result: DesignBuildResult } | { kind: "failed"; error: unknown };

/**
 * How many *finished* builds this project keeps a command object for.
 *
 * The same number the workspace keeps rows for, and for the same reason: a
 * project re-indexed all day would otherwise hold one command — and the
 * closure over its whole build — for the life of the worker.
 *
 * The bound holds **at settlement**, not at the next start: a burst of builds
 * that all end and are never followed by another one would otherwise keep
 * every closure for the life of the worker. A build that is still running is
 * never counted and never released, and a build whose last row has not been
 * published yet is still held — the sweep runs after `onSettled` returns.
 */
export const FINISHED_COMMANDS_KEPT = 8;

/** One build this project started, and whether it has ended. */
interface HeldBuild {
  command: DesignBuildCommand;
  owner: DesignBuildOwner;
  /** True once the build has settled *and* its outcome has been announced. */
  finished: boolean;
}

/**
 * One project's index, review and builds.
 *
 * Deliberately **not** a `DesignIndexBridge`: a build needs an owning session
 * and this class cannot know one, so the bridge a session's tools hold is the
 * session-bound wrapper the worker makes over this (`server.ts`), and every
 * build reaches here with its owner already decided.
 */
export class ProjectDesignIndex {
  private readonly builds = new Map<string, HeldBuild>();

  constructor(private readonly options: ProjectDesignIndexOptions) {}

  /** The reviewed index, or undefined when this project has never been indexed. */
  async index(): Promise<DesignIndex | undefined> {
    const stored = readIndex(this.options.projectCwd);
    if (!stored) return undefined;
    return applyReview(stored, readReview(this.options.projectCwd));
  }

  /** The commands this project has started, newest last. */
  commands(): DesignBuildCommand[] {
    return [...this.builds.values()].map((held) => held.command);
  }

  command(commandId: string): DesignBuildCommand | undefined {
    return this.builds.get(commandId)?.command;
  }

  /** The session one build belongs to. Read-only: it is fixed at admission. */
  owner(commandId: string): DesignBuildOwner | undefined {
    return this.builds.get(commandId)?.owner;
  }

  async startBuild(input: { rebuild: boolean; appRoot?: string; maxFiles?: number; owner: DesignBuildOwner }): Promise<{ commandId: string; title: string; appRoot: string }> {
    const appRoot = input.appRoot ?? ".";
    if (input.rebuild) clearParseCache(this.options.stateDir, this.options.projectKey);
    const cache: ParseCache = fileParseCache(this.options.stateDir, this.options.projectKey);
    // The id is read from a holder rather than captured: the build reports its
    // first progress *synchronously*, inside `startDesignIndexBuild`, so a
    // closure over a `const` declared after this call would be in its temporal
    // dead zone exactly once — on the report that says the build started.
    const started: { id?: string } = {};
    // Resolved here, at the boundary, so one build runs on one profile from
    // its first completion to its last.
    const synthesis = this.options.synthesis?.();
    const command = startDesignIndexBuild({
      projectCwd: this.options.projectCwd,
      appRoot,
      cache,
      ...(input.maxFiles !== undefined ? { budget: { maxFiles: input.maxFiles } } : {}),
      ...(synthesis !== undefined ? { synthesis } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      onProgress: (progress) => {
        if (started.id !== undefined) this.options.onProgress?.(started.id, progress);
      },
    });
    const commandId = command.id;
    started.id = commandId;
    const held: HeldBuild = { command, owner: input.owner, finished: false };
    this.builds.set(commandId, held);
    this.options.onCommand?.(command, input.owner);
    // Registered here, before anything else can attach to `done`, so the
    // settlement below runs before any caller's own continuation: the row that
    // says how this build ended is published before the build can be released,
    // and before whoever awaited it carries on.
    //
    // A failed build must not become an unhandled rejection either; the
    // command's own `done` still carries the failure for whoever awaits it.
    command.done.then(
      (result) => {
        this.settle(held, { kind: "done", result });
      },
      (error: unknown) => {
        this.settle(held, { kind: "failed", error });
      },
    );
    return { commandId, title: command.title, appRoot };
  }

  /** Wait for one build. Used by the tools' tests and by a person's "stop". */
  async wait(commandId: string): Promise<void> {
    await this.builds.get(commandId)?.command.done.catch(() => {});
  }

  stop(commandId: string): boolean {
    const held = this.builds.get(commandId);
    if (!held) return false;
    held.command.stop();
    return true;
  }

  /**
   * One build has ended: say how, then bound what is kept.
   *
   * The order is the whole point. `onSettled` is where the fleet row that says
   * *failed*, *stopped* or *completed* is published, and it is called while
   * this build is still in the map — so nothing can be forgotten between the
   * build ending and the person being told how it ended.
   */
  private settle(held: HeldBuild, outcome: DesignBuildOutcome): void {
    try {
      this.options.onSettled?.(held.command, held.owner, outcome);
    } catch {
      // An observer that threw has lost its row, which is its own problem to
      // report; it must not leave every finished build in this worker held for
      // the life of the process, so the sweep below still runs.
    } finally {
      held.finished = true;
      this.release();
    }
  }

  /**
   * Forget the oldest ended builds past the bound.
   *
   * Insertion order is start order, so the oldest ended build goes first. This
   * is the index's own bound rather than a caller's callback: the tools, the
   * workspace and a scripted world all start builds through here, and a bound
   * only one of them maintained would not be a bound at all.
   */
  private release(): void {
    const ended = [...this.builds.entries()].filter(([, held]) => held.finished);
    for (let index = 0; index < ended.length - FINISHED_COMMANDS_KEPT; index += 1) {
      this.builds.delete(ended[index]![0]);
    }
  }

  async review(input: {
    entryId: string;
    action: DesignReviewAction;
    name?: string;
    intoEntryId?: string;
    into?: string[];
    note?: string;
    useForNewWork?: boolean;
    expectedFactsDigest?: string;
    actor: ReviewActor;
  }): Promise<{ entry: DesignIndexEntry; reviewed: number; total: number }> {
    const stored = readIndex(this.options.projectCwd);
    if (!stored) {
      throw new ReviewRefused(
        "no_index",
        "This project has no design index yet, so there is nothing to review.",
        "call build_design_index to build it first",
      );
    }
    const document = readReview(this.options.projectCwd);
    const current = applyReview(stored, document);
    const next = applyReviewAction(document, current, {
      entryId: input.entryId,
      action: input.action,
      actor: input.actor,
      at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.intoEntryId !== undefined ? { intoEntryId: input.intoEntryId } : {}),
      ...(input.into !== undefined ? { into: input.into } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.useForNewWork !== undefined ? { useForNewWork: input.useForNewWork } : {}),
      ...(input.expectedFactsDigest !== undefined ? { expectedFactsDigest: input.expectedFactsDigest } : {}),
    });
    writeReview(this.options.projectCwd, next);
    const reviewed = applyReview(stored, next);
    writeIndex(this.options.projectCwd, reviewed);
    const entry = reviewed.entries.find((candidate) => candidate.id === input.entryId);
    if (!entry) {
      throw new ReviewRefused(
        "no_such_entry",
        `This index has no entry called "${input.entryId}".`,
        "call inspect_design_index to list the entries with their ids",
      );
    }
    const progress = reviewProgress(reviewed);
    return { entry, reviewed: progress.reviewed, total: progress.total };
  }
}
