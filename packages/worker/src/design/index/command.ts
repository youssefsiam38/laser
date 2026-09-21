/**
 * The index build as a visible, bounded, stoppable Command.
 *
 * `docs/design-phase.md` ("Re-index") asks for a fleet Command with a budget
 * that the person can stop, and progress shown **by files, never by percent** —
 * a percentage of an unknown tree is a number the product would be making up.
 *
 * It is not a shell task: the Design phase runs nothing (D-353), so there is
 * no process to spawn and nothing for `background-work` to own. What this
 * exposes instead is the vocabulary a fleet row needs — a title, a state,
 * progress, an elapsed time and `stop()` — so the host (M21-T13) can publish
 * it beside the agents without either side learning about the other.
 *
 * Incremental by construction: a file whose digest is already in the parse
 * cache is not opened again, and the run reports how many files it actually
 * re-parsed.
 */
import type { DesignIndex, ModelProfile } from "@lasercode/protocol";
import { assembleIndex, parseSourceFile, type L0Build } from "./build.js";
import { stableId, type DesignFact, type Gap } from "./facts.js";
import { applySynthesis, synthesise, type SynthesisOptions } from "./l1-synthesis.js";
import { applyReview, type ReviewDocument } from "./review.js";
import { noParseCache, readReview, writeIndex, writeReview, type ParseCache } from "./storage.js";
import { openedFiles, scanProject, type ScanBudget, type ScanResult } from "./scan.js";

/** Where a build is, in the words a fleet row shows. */
export const DESIGN_BUILD_PHASES = ["scanning", "parsing", "grouping", "describing", "writing", "done", "stopped", "failed"] as const;
export type DesignBuildPhase = (typeof DESIGN_BUILD_PHASES)[number];

export interface DesignBuildProgress {
  phase: DesignBuildPhase;
  /** Files opened and parsed so far. Never a percentage. */
  filesParsed: number;
  /** Files the walk found and would parse. Grows while `scanning`. */
  filesFound: number;
  /** Files answered from the digest cache instead of being re-parsed. */
  filesFromCache: number;
  /** The file being read, for the line under the title. */
  currentPath?: string | undefined;
  /** Milliseconds since the command started. */
  elapsedMs: number;
}

export interface DesignBuildBudget extends Partial<ScanBudget> {
  /** How long the whole build may take before it stops itself. */
  maxMs?: number;
}

export const DEFAULT_BUILD_MS = 5 * 60_000;

/** Files parsed between two turns of the event loop. */
export const YIELD_EVERY_FILES = 8;

export interface DesignBuildOptions {
  projectCwd: string;
  /** The app root inside the project, for a monorepo. Defaults to the project. */
  appRoot?: string;
  budget?: DesignBuildBudget;
  cache?: ParseCache;
  /** Review decisions to preserve. Read from the project when absent. */
  review?: ReviewDocument;
  /** Synthesis. Absent means L0 only, and the index says so. */
  synthesis?: Omit<SynthesisOptions, "onlyEntryIds" | "signal"> & { profileId?: string };
  /** Stops the build between files. What was parsed is still written. */
  signal?: AbortSignal;
  onProgress?: (progress: DesignBuildProgress) => void;
  /** Injected in tests. Defaults to the wall clock. */
  now?: () => number;
  /** Repository state, when the caller knows it. */
  builtFrom?: DesignIndex["builtFrom"];
  /** Write `index.json`/`review.json` into the project. On by default. */
  write?: boolean;
}

export interface DesignBuildResult {
  index: DesignIndex;
  review: ReviewDocument;
  progress: DesignBuildProgress;
  /** Where the index was written, when it was. */
  indexPath?: string;
  l0: L0Build;
  stopped: boolean;
  /** Files whose digest changed (or were new) and were therefore re-parsed. */
  reparsed: string[];
}

/** A build in flight, as a fleet row reads it. */
export interface DesignBuildCommand {
  id: string;
  title: string;
  progress(): DesignBuildProgress;
  /** Ask the build to stop. It finishes the file it is on and writes what it has. */
  stop(): void;
  /** The build itself. Resolves even when it was stopped. */
  done: Promise<DesignBuildResult>;
}

function profileOf(synthesis: DesignBuildOptions["synthesis"]): ModelProfile | null {
  return synthesis?.profile ?? null;
}

/**
 * Run a build to completion. `startDesignIndexBuild` wraps it in the command
 * shape; tests and the tools use whichever they need.
 */
export async function buildDesignIndex(options: DesignBuildOptions): Promise<DesignBuildResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const cache = options.cache ?? noParseCache();
  const appRoot = options.appRoot ?? ".";
  const root = appRoot === "." ? options.projectCwd : `${options.projectCwd}/${appRoot}`;
  const maxMs = options.budget?.maxMs ?? DEFAULT_BUILD_MS;

  const progress: DesignBuildProgress = { phase: "scanning", filesParsed: 0, filesFound: 0, filesFromCache: 0, elapsedMs: 0 };
  const report = (patch: Partial<DesignBuildProgress>): void => {
    Object.assign(progress, patch, { elapsedMs: now() - startedAt });
    options.onProgress?.({ ...progress });
  };
  report({});

  const budget: Partial<ScanBudget> = {};
  if (options.budget?.maxFiles !== undefined) budget.maxFiles = options.budget.maxFiles;
  if (options.budget?.maxBytes !== undefined) budget.maxBytes = options.budget.maxBytes;
  if (options.budget?.maxFileBytes !== undefined) budget.maxFileBytes = options.budget.maxFileBytes;
  if (options.budget?.maxEntries !== undefined) budget.maxEntries = options.budget.maxEntries;

  const scan: ScanResult = scanProject(root, { budget, ...(options.signal ? { signal: options.signal } : {}) });
  const files = openedFiles(scan);
  report({ phase: "parsing", filesFound: files.length });

  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const reparsed: string[] = [];
  let stopped = options.signal?.aborted === true || scan.truncated;
  let fromCache = 0;
  let sinceYield = 0;

  for (const file of files) {
    // Give the loop back between batches of files (M21-T13). Parsing is all
    // synchronous, so without this the whole build would run in one tick: the
    // fleet row would jump straight from "started" to "read 4 000 files", Stop
    // could not be delivered while it ran, and the worker would answer nothing
    // else meanwhile. Progress by files is only true if a file is a moment.
    if ((sinceYield += 1) >= YIELD_EVERY_FILES) {
      sinceYield = 0;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    if (options.signal?.aborted === true || now() - startedAt > maxMs) {
      stopped = true;
      gaps.push({
        path: file.path,
        reason: options.signal?.aborted === true
          ? "you stopped this build here; everything parsed before it is in the index."
          : "the build reached its time budget here; everything parsed before it is in the index.",
      });
      break;
    }
    const cached = cache.get(file.digest, file.path);
    if (cached) {
      facts.push(...cached.facts);
      gaps.push(...cached.gaps);
      fromCache += 1;
      report({ filesParsed: progress.filesParsed + 1, filesFromCache: fromCache, currentPath: file.path });
      continue;
    }
    const parsed = parseSourceFile(file);
    cache.set(file.digest, file.path, parsed);
    reparsed.push(file.path);
    facts.push(...parsed.facts);
    gaps.push(...parsed.gaps);
    report({ filesParsed: progress.filesParsed + 1, currentPath: file.path });
  }
  cache.flush();

  report({ phase: "grouping" });
  const l0 = assembleIndex(facts, gaps, scan, {
    indexId: stableId("idx", options.projectCwd, appRoot),
    builtAt: new Date(now()).toISOString(),
    appRoot,
    parsedFiles: progress.filesParsed,
    cachedFiles: fromCache,
    ...(options.builtFrom !== undefined ? { builtFrom: options.builtFrom } : {}),
    ...(stopped ? { stoppedEarly: true } : {}),
  });

  let index = l0.index;
  if (options.synthesis && options.signal?.aborted !== true) {
    report({ phase: "describing" });
    const result = await synthesise(index, l0.facts, {
      models: options.synthesis.models,
      profile: profileOf(options.synthesis),
      ...(options.synthesis.timeoutMs !== undefined ? { timeoutMs: options.synthesis.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    index = applySynthesis(index, result, options.synthesis.profileId);
  }

  report({ phase: "writing" });
  const review = options.review ?? safeReview(options.projectCwd);
  const reviewed = applyReview(index, review);
  let indexPath: string | undefined;
  if (options.write !== false) {
    indexPath = writeIndex(options.projectCwd, reviewed);
    writeReview(options.projectCwd, review);
  }
  report({ phase: stopped ? "stopped" : "done", currentPath: undefined });

  return {
    index: reviewed,
    review,
    progress: { ...progress },
    ...(indexPath !== undefined ? { indexPath } : {}),
    l0,
    stopped,
    reparsed,
  };
}

function safeReview(projectCwd: string): ReviewDocument {
  try {
    return readReview(projectCwd);
  } catch {
    // A damaged review file is reported by `readReview` to whoever reads it
    // directly; a build must not lose the whole index over it.
    return { version: 1, entries: {}, eras: {} };
  }
}

/**
 * Start a build as a command: it runs, it reports progress by files, and the
 * person can stop it. Nothing here waits on anything the caller has to poll —
 * `done` is the whole answer.
 */
export function startDesignIndexBuild(options: DesignBuildOptions): DesignBuildCommand {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let latest: DesignBuildProgress = { phase: "scanning", filesParsed: 0, filesFound: 0, filesFromCache: 0, elapsedMs: 0 };
  const id = stableId("cmd", options.projectCwd, options.appRoot ?? ".", String(Date.now()));
  const done = buildDesignIndex({
    ...options,
    signal,
    onProgress: (progress) => {
      latest = progress;
      options.onProgress?.(progress);
    },
  }).catch((error: unknown) => {
    latest = { ...latest, phase: "failed" };
    throw error;
  });
  return {
    id,
    title: "Indexing the design system",
    progress: () => ({ ...latest }),
    stop: () => {
      controller.abort();
    },
    done,
  };
}

/** The line a fleet row shows under the title: files, never a percentage. */
export function progressLine(progress: DesignBuildProgress): string {
  const parsed = `${String(progress.filesParsed)} of ${String(Math.max(progress.filesFound, progress.filesParsed))} files`;
  const cached = progress.filesFromCache > 0 ? `, ${String(progress.filesFromCache)} unchanged` : "";
  switch (progress.phase) {
    case "scanning":
      return "Looking for the files that describe the design";
    case "parsing":
      return `Reading ${parsed}${cached}`;
    case "grouping":
      return `Grouping what ${parsed} said`;
    case "describing":
      return "Describing components, conventions and eras";
    case "writing":
      return "Writing the index";
    case "done":
      return `Read ${parsed}${cached}`;
    case "stopped":
      return `Stopped after ${parsed}${cached}`;
    case "failed":
      return "The index could not be built";
  }
}
