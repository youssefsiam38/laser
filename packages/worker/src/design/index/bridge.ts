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
import { startDesignIndexBuild, type DesignBuildCommand, type DesignBuildOptions, type DesignBuildProgress } from "./command.js";
import { applyReview, applyReviewAction, reviewProgress, ReviewRefused, type ReviewActor, type DesignReviewAction } from "./review.js";
import { clearParseCache, fileParseCache, readIndex, readReview, writeIndex, writeReview, type ParseCache } from "./storage.js";
import type { DesignIndexBridge } from "./tools.js";

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
  /** Told about every build, so the fleet can show it. */
  onCommand?: (command: DesignBuildCommand) => void;
  onProgress?: (commandId: string, progress: DesignBuildProgress) => void;
  now?: () => number;
}

/** One project's index, review and builds. */
export class ProjectDesignIndex implements DesignIndexBridge {
  private readonly builds = new Map<string, DesignBuildCommand>();

  constructor(private readonly options: ProjectDesignIndexOptions) {}

  /** The reviewed index, or undefined when this project has never been indexed. */
  async index(): Promise<DesignIndex | undefined> {
    const stored = readIndex(this.options.projectCwd);
    if (!stored) return undefined;
    return applyReview(stored, readReview(this.options.projectCwd));
  }

  /** The commands this project has started, newest last. */
  commands(): DesignBuildCommand[] {
    return [...this.builds.values()];
  }

  command(commandId: string): DesignBuildCommand | undefined {
    return this.builds.get(commandId);
  }

  async startBuild(input: { rebuild: boolean; appRoot?: string; maxFiles?: number }): Promise<{ commandId: string; title: string; appRoot: string }> {
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
    this.builds.set(commandId, command);
    this.options.onCommand?.(command);
    // A failed build must not become an unhandled rejection: the command's
    // own `done` still carries the failure for whoever awaits it.
    command.done.catch(() => {});
    return { commandId, title: command.title, appRoot };
  }

  /** Wait for one build. Used by the tools' tests and by a person's "stop". */
  async wait(commandId: string): Promise<void> {
    await this.builds.get(commandId)?.done.catch(() => {});
  }

  stop(commandId: string): boolean {
    const command = this.builds.get(commandId);
    if (!command) return false;
    command.stop();
    return true;
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
