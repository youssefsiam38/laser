/**
 * The real bridge behind the four tools: one project's adapters, its research
 * cache, one run's budget, and the write path to the host.
 *
 * It is the only place that holds what a run has seen — every source a search
 * returned, every body a read fetched — which is what makes two contract
 * rules enforceable rather than advisory:
 *
 * - a finding may only cite a source this session really found or read
 *   (`knownSource`), and
 * - an excerpt must appear in the text this session was given
 *   (`applyResearchOperation` with the run's read record), which is checked
 *   **here**, because this is where the fetched text exists. The host re-runs
 *   every other rule on the way in (`docs/leap/m21-research-plan.md`).
 *
 * Writes go to a `ResearchStore`, which the host implements over
 * `project/work/revise`. Nothing in this file knows about the transport.
 */
import {
  applyResearchOperation,
  researchAdapterEnabled,
  enabledResearchAdapters,
  type ResearchAdapterId,
  type ResearchBody,
  type ResearchOperation,
  type ResearchSessionRead,
  type ResearchSources,
  type SourceRef,
} from "@lasercode/protocol";
import type { ProcessRunner } from "../git-actions/index.js";
import { createProcessRunner } from "../git-actions/index.js";
import { ResearchLedger, type ResearchSpend } from "./budget.js";
import { fileResearchCache, memoryResearchCache, type ResearchCache } from "./cache.js";
import { ResearchRefused } from "./errors.js";
import { researchAdapterImplementation } from "./adapters/index.js";
import { createResearchFetcher } from "./adapters/fetch.js";
import type { ResearchAdapterContext, ResearchFetcher, ResearchReadResult, ResearchSearchResult, ResearchWebSearch } from "./adapters/types.js";
import type { ResearchArtifact, ResearchBridge, ResearchWriteAck } from "./tools.js";

/** The host's side of a write. One method to apply, one to read the artifact. */
export interface ResearchStore {
  artifact(ref?: string): Promise<{ ref: string; revisionId: string; body: ResearchBody }>;
  /**
   * Apply one operation, host-side, and store the revision it produces.
   *
   * The host re-runs `applyResearchOperation()` against its own current body:
   * this worker's pre-check is a courtesy to the model, never the authority.
   */
  apply(input: { researchRef: string; expectedRevisionId: string; idempotencyKey: string; operation: ResearchOperation }): Promise<ResearchWriteAck>;
}

export interface ProjectResearchOptions {
  projectCwd: string;
  stateDir?: string;
  projectKey?: string;
  /** Settings → Research sources, already merged global-then-project. */
  sources: ResearchSources;
  store: ResearchStore;
  /** The person's configured search provider. Absent means the web cannot be searched. */
  webSearch?: ResearchWebSearch;
  fetch?: ResearchFetcher;
  run?: ProcessRunner;
  cache?: ResearchCache;
  /** Per-run overrides of the settings budget. */
  budget?: Partial<ResearchSources["budget"]>;
  /** Where this session's attachments live, for the document adapter. */
  attachmentsDir?: string;
  now?: () => number;
  signal?: AbortSignal;
  /** Told whenever the run spends something, so the fleet row can move. */
  onSpend?: (spend: ResearchSpend, line: string) => void;
}

/** How many bodies of one source a run keeps for the excerpt check. */
const READS_KEPT_PER_SOURCE = 8;

/** Which adapter owns a source id, when a call did not say. */
export function adapterForSourceId(id: string): ResearchAdapterId | undefined {
  if (/^https?:\/\//i.test(id)) return "web";
  if (id.startsWith("git:")) return "repository";
  if (id.startsWith("pkg:")) return "package";
  if (id.startsWith("file:")) return "document";
  if (id.startsWith("path:") || id.startsWith("commit:")) return "project";
  return undefined;
}

export class ProjectResearch implements ResearchBridge {
  readonly ledger: ResearchLedger;
  private readonly cache: ResearchCache;
  private readonly fetcher: ResearchFetcher;
  private readonly runner: ProcessRunner;
  private readonly known = new Map<string, SourceRef>();
  /**
   * What this run read, per source. A list, because one source can be read as
   * several bodies — a repository file by file — and an excerpt may come from
   * any of them. Bounded, so a long run does not keep every page forever.
   */
  private readonly reads = new Map<string, ResearchSessionRead[]>();

  constructor(private readonly options: ProjectResearchOptions) {
    this.ledger = new ResearchLedger({
      budget: { ...options.sources.budget, ...options.budget },
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.cache =
      options.cache ??
      (options.stateDir !== undefined
        ? fileResearchCache({ stateDir: options.stateDir, projectKey: options.projectKey ?? "project", maxBytes: options.sources.cacheMaxBytes })
        : memoryResearchCache(options.sources.cacheMaxBytes));
    this.fetcher = options.fetch ?? createResearchFetcher();
    this.runner = options.run ?? createProcessRunner();
  }

  /**
   * The adapters this session has. A disabled one is absent, not offered and
   * failing; `web` stays present without a connected provider because reading
   * a page the person names still works, and the refusal for searching says
   * exactly what is missing.
   */
  adapters(): ResearchAdapterId[] {
    return enabledResearchAdapters(this.options.sources);
  }

  private context(): ResearchAdapterContext {
    return {
      projectCwd: this.options.projectCwd,
      ...(this.options.stateDir !== undefined ? { stateDir: this.options.stateDir } : {}),
      ...(this.options.projectKey !== undefined ? { projectKey: this.options.projectKey } : {}),
      ...(this.options.attachmentsDir !== undefined ? { attachmentsDir: this.options.attachmentsDir } : {}),
      sources: this.options.sources,
      ledger: this.ledger,
      cache: this.cache,
      fetch: this.fetcher,
      run: this.runner,
      ...(this.options.webSearch !== undefined ? { webSearch: this.options.webSearch } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
    };
  }

  private checkEnabled(id: ResearchAdapterId): void {
    if (researchAdapterEnabled(this.options.sources, id)) return;
    throw new ResearchRefused(
      "adapter_disabled",
      `The ${id} source is switched off for this project, so it cannot be used.`,
      `use one of the sources this project has: ${this.adapters().join(", ") || "none — say so and work from what you already know"}`,
    );
  }

  private spent(): void {
    this.options.onSpend?.(this.ledger.spent(), this.ledger.line());
  }

  async search(input: { adapter: ResearchAdapterId; query: string; limit: number; after?: string; before?: string; cursor?: string }): Promise<ResearchSearchResult> {
    this.checkEnabled(input.adapter);
    const adapter = researchAdapterImplementation(input.adapter);
    const result = await adapter.search(
      {
        query: input.query,
        limit: input.limit,
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      },
      this.context(),
    );
    for (const hit of result.hits) this.known.set(hit.sourceRef.id, hit.sourceRef);
    this.spent();
    return result;
  }

  async read(input: { adapter?: ResearchAdapterId; sourceId: string; offset?: number; limit?: number; paths?: string[] }): Promise<ResearchReadResult> {
    const id = input.adapter ?? adapterForSourceId(input.sourceId);
    if (!id) {
      throw new ResearchRefused(
        "unknown_source_kind",
        `"${input.sourceId.slice(0, 120)}" does not say which source it belongs to.`,
        "search first and read one of the hits by the id it returned, or name the adapter",
      );
    }
    this.checkEnabled(id);
    const ref: SourceRef = this.known.get(input.sourceId) ?? {
      kind: researchAdapterImplementation(id).descriptor.sourceKind,
      id: input.sourceId,
      title: "",
      fetchedVia: id,
      trust: "unknown",
    };
    const result = await researchAdapterImplementation(id).read(
      {
        ref,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.paths !== undefined ? { paths: input.paths } : {}),
      },
      this.context(),
    );
    // What the run has seen: the source as it should be cited, and the text
    // an excerpt must come from.
    this.known.set(result.source.id, result.source);
    this.known.set(input.sourceId, result.source);
    const body = this.cache.get(result.bodyKey);
    const record: ResearchSessionRead = {
      digest: result.digest,
      text: body?.text ?? result.text,
      ...(result.canonical !== undefined ? { canonical: result.canonical } : {}),
    };
    const existing = this.reads.get(result.source.id) ?? [];
    const kept = existing.filter((entry) => entry.digest !== record.digest);
    kept.push(record);
    this.reads.set(result.source.id, kept.slice(-READS_KEPT_PER_SOURCE));
    this.spent();
    return result;
  }

  knownSource(sourceId: string): SourceRef | undefined {
    return this.known.get(sourceId);
  }

  hasRead(sourceId: string): boolean {
    return this.reads.has(sourceId);
  }

  /** What this run read, for the excerpt check. The host gets the digests. */
  readRecord(): ReadonlyMap<string, readonly ResearchSessionRead[]> {
    return this.reads;
  }

  budgetLine(): string {
    return this.ledger.line();
  }

  async artifact(ref?: string): Promise<ResearchArtifact> {
    const loaded = await this.options.store.artifact(ref);
    return {
      ref: loaded.ref,
      revisionId: loaded.revisionId,
      question: loaded.body.question,
      questions: loaded.body.questions.map((question) => ({ id: question.id, text: question.text, state: question.state })),
      findingCount: loaded.body.findings.length,
    };
  }

  /**
   * Pre-check the operation against the body this session last read, then send
   * it to the host, which applies it for real.
   *
   * The pre-check is what makes a refusal cheap and specific — the excerpt
   * check in particular can only happen here, because the fetched text lives
   * in this run's cache and never crosses to the host.
   */
  async apply(input: { researchRef: string; expectedRevisionId: string; idempotencyKey: string; operation: ResearchOperation }): Promise<ResearchWriteAck> {
    const current = await this.options.store.artifact(input.researchRef);
    if (current.revisionId !== input.expectedRevisionId) {
      throw new ResearchRefused(
        "stale_revision",
        `This research has moved on since you read it: you sent revision ${input.expectedRevisionId}, and it is now at ${current.revisionId}.`,
        `call inspect_project_work on ${current.ref} to read it as it is now, then write again with ${current.revisionId}`,
      );
    }
    applyResearchOperation(current.body, input.operation, {
      reads: this.reads,
      ...(this.options.now !== undefined ? { now: () => new Date(this.options.now!()) } : {}),
    });
    return this.options.store.apply(input);
  }
}
