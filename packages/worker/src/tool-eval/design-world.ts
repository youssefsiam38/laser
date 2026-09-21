/**
 * The world the Design Index tools are evaluated in (M26-T3's recipe, step 4).
 *
 * The harness tools get a scripted fleet because a real one would start real
 * agents. The design tools need no such substitution: the index is built by
 * parsing files, so the world is simply **a real project in a temporary
 * directory** — a copy of one of the design fixtures, indexed by the real
 * builder, stored through the real project-config path. Nothing is scripted
 * except the model that chooses the calls.
 *
 * That is the point of the parse-only design: a tool that never runs anything
 * can be evaluated against the real thing.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignIndex, DesignIndexEntry } from "@lasercode/protocol";
import { ProjectDesignIndex } from "../design/index/bridge.js";
import type { DesignIndexBridge } from "../design/index/tools.js";
import type { DesignReviewAction, ReviewActor } from "../design/index/review.js";

export interface ScriptedDesignWorldOptions {
  /** The fixture project to copy: an absolute path to a directory. */
  projectSource: string;
  /** Whether the index has already been built when the run starts. */
  built: boolean;
}

/** A real project, a real index, a real review — in a directory that is thrown away. */
export class ScriptedDesignWorld implements DesignIndexBridge {
  readonly projectCwd: string;
  readonly stateDir: string;
  private readonly project: ProjectDesignIndex;
  private readonly options: ScriptedDesignWorldOptions;
  private prepared = false;

  constructor(options: ScriptedDesignWorldOptions) {
    this.options = options;
    const base = mkdtempSync(join(tmpdir(), "design-tool-eval-"));
    this.projectCwd = join(base, "project");
    this.stateDir = join(base, "state");
    cpSync(options.projectSource, this.projectCwd, { recursive: true });
    this.project = new ProjectDesignIndex({ projectCwd: this.projectCwd, stateDir: this.stateDir, projectKey: "tool-eval" });
  }

  /** Build the starting index, when the fixture says the project has one. */
  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    if (!this.options.built) return;
    const started = await this.project.startBuild({ rebuild: false });
    await this.project.wait(started.commandId);
  }

  async index(): Promise<DesignIndex | undefined> {
    return this.project.index();
  }

  async startBuild(input: { rebuild: boolean; appRoot?: string; maxFiles?: number }): Promise<{ commandId: string; title: string; appRoot: string }> {
    const started = await this.project.startBuild(input);
    // A model must not have to wait for the command; the evaluation does, so
    // the next recorded call reads an index that exists.
    await this.project.wait(started.commandId);
    return started;
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
    return this.project.review(input);
  }

  /** One entry of the current index, for a recorded call that has to name one. */
  async entry(kind: DesignIndexEntry["kind"], name: string): Promise<DesignIndexEntry | undefined> {
    const index = await this.index();
    return index?.entries.find((entry) => entry.kind === kind && entry.name === name);
  }

  dispose(): void {
    rmSync(join(this.projectCwd, ".."), { recursive: true, force: true });
  }
}
