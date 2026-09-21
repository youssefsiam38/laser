/**
 * The world the Research tools are evaluated in (M26-T3's recipe, step 4;
 * M21-T26).
 *
 * Everything is real except the outside world: the adapters, the cache, the
 * budget ledger, the confidence rule, the tools and the operation applier are
 * the product's own, and what is scripted is exactly the three things a test
 * may not do — the network (`http/*.json`), the person's search provider
 * (`search/*.json`) and git (`git/*.json`), each replayed from a recording.
 *
 * The store is the **host's half**, played honestly: it applies every write
 * with `applyResearchOperation()`, the same function the host runs, so a
 * fixture that passes here is a fixture whose rules the host will apply the
 * same way.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyResearchOperation,
  defaultResearchSources,
  readResearchSources,
  researchStatusFrom,
  type ResearchAdapterId,
  type ResearchBody,
  type ResearchOperation,
  type ResearchSources,
} from "@lasercode/protocol";
import type { ProcessResult, ProcessRunner } from "../git-actions/index.js";
import { ProjectResearch, type ResearchStore } from "../research/bridge.js";
import type { ResearchFetcher } from "../research/adapters/types.js";
import type { ResearchArtifact, ResearchBridge, ResearchWriteAck } from "../research/tools.js";
import type { ResearchReadResult, ResearchSearchResult } from "../research/adapters/types.js";
import type { SourceRef } from "@lasercode/protocol";

interface RecordedResponse {
  url: string;
  status?: number;
  contentType?: string;
  body: string;
}

interface RecordedSearch {
  query: string;
  answer: unknown;
}

interface RecordedGit {
  /** The arguments, joined by a space, as the adapter passes them. */
  args: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  spawned?: boolean;
}

export interface ScriptedResearchWorldOptions {
  /** `test/fixtures/research`, holding `http/`, `search/`, `git/` and `project/`. */
  fixtureRoot: string;
  /** The project directory to copy under `project/`. Defaults to `project`. */
  project?: string;
  /** The research body the run starts from. */
  body?: ResearchBody;
  /** Settings → Research sources for this run. Defaults to everything shipped, on. */
  sources?: Partial<ResearchSources>;
  /** Whether a search provider is connected. Default true. */
  searchConnected?: boolean;
  now?: () => number;
}

export const DEFAULT_RESEARCH_BODY: ResearchBody = {
  question: "Which library should this project use to read PDF files in Node?",
  scope: { in: ["Node libraries that extract text"], out: ["Rendering PDFs in a browser"], constraints: ["Permissive licence"] },
  status: "open",
  questions: [
    { id: "q1", text: "Which maintained Node libraries extract text from a PDF?", state: "open", findings: [] },
    { id: "q2", text: "What licence does each one carry?", state: "open", findings: [] },
    { id: "q3", text: "Which one should this project adopt?", state: "open", findings: [] },
  ],
  findings: [],
  unresolved: [],
  sources: [],
};

/** One in-memory research artifact, applying writes the way the host does. */
export class ScriptedResearchStore implements ResearchStore {
  private bodyValue: ResearchBody;
  private revision = 1;
  readonly ref = "RES-1";
  readonly attentions: Array<{ questionId: string; text: string }> = [];
  readonly stale: string[] = [];

  constructor(body: ResearchBody) {
    this.bodyValue = { ...body, status: researchStatusFrom(body.questions, body.status) };
  }

  get body(): ResearchBody {
    return this.bodyValue;
  }

  get revisionId(): string {
    return `rev${String(this.revision)}`;
  }

  async artifact(): Promise<{ ref: string; revisionId: string; body: ResearchBody }> {
    return { ref: this.ref, revisionId: this.revisionId, body: this.bodyValue };
  }

  async apply(input: { researchRef: string; expectedRevisionId: string; idempotencyKey: string; operation: ResearchOperation }): Promise<ResearchWriteAck> {
    const applied = applyResearchOperation(this.bodyValue, input.operation);
    this.bodyValue = applied.body;
    this.revision += 1;
    if (applied.attention) this.attentions.push({ questionId: applied.attention.questionId, text: applied.attention.text });
    this.stale.push(...applied.staleRefs);
    return {
      revisionId: this.revisionId,
      ...(applied.findingId !== undefined ? { findingId: applied.findingId } : {}),
      questionId: applied.questionId,
      status: applied.body.status,
      ...(applied.attention !== undefined ? { attention: applied.attention } : {}),
      staleRefs: applied.staleRefs,
      ...(applied.reuseBlocked !== undefined ? { reuseBlocked: applied.reuseBlocked } : {}),
    };
  }
}

/** A real research run against recorded answers. */
export class ScriptedResearchWorld implements ResearchBridge {
  readonly projectCwd: string;
  readonly stateDir: string;
  readonly store: ScriptedResearchStore;
  readonly research: ProjectResearch;
  /** Every URL, query and git command the run really asked for. */
  readonly requests: string[] = [];
  private readonly base: string;
  private readonly http = new Map<string, RecordedResponse>();
  private readonly searches = new Map<string, string>();
  private readonly git = new Map<string, ProcessResult>();

  constructor(private readonly options: ScriptedResearchWorldOptions) {
    this.base = mkdtempSync(join(tmpdir(), "research-tool-eval-"));
    this.projectCwd = join(this.base, "project");
    this.stateDir = join(this.base, "state");
    const source = join(options.fixtureRoot, options.project ?? "project");
    if (existsSync(source)) cpSync(source, this.projectCwd, { recursive: true });
    else mkdirSync(this.projectCwd, { recursive: true });
    this.load(options.fixtureRoot);
    this.store = new ScriptedResearchStore(options.body ?? DEFAULT_RESEARCH_BODY);

    const sources: ResearchSources = { ...defaultResearchSources(), ...options.sources };
    this.research = new ProjectResearch({
      projectCwd: this.projectCwd,
      stateDir: this.stateDir,
      projectKey: "tool-eval",
      sources,
      store: this.store,
      fetch: this.fetcher(),
      run: this.runner(),
      ...(options.searchConnected === false ? {} : { webSearch: this.webSearch() }),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /** Settings as a document, the way a project's `.laser/settings.json` holds them. */
  static sourcesFromDocument(document: unknown): ResearchSources {
    return readResearchSources(document);
  }

  private load(root: string): void {
    const read = <T>(directory: string): T[] => {
      const path = join(root, directory);
      if (!existsSync(path)) return [];
      return readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(path, name), "utf8")) as T);
    };
    for (const entry of read<RecordedResponse>("http")) this.http.set(entry.url, entry);
    for (const entry of read<RecordedSearch>("search")) {
      this.searches.set(entry.query.trim().toLowerCase(), typeof entry.answer === "string" ? entry.answer : JSON.stringify(entry.answer));
    }
    for (const entry of read<RecordedGit>("git")) {
      this.git.set(entry.args, {
        code: entry.code ?? 0,
        stdout: entry.stdout ?? "",
        stderr: entry.stderr ?? "",
        spawned: entry.spawned ?? true,
        timedOut: false,
      });
    }
  }

  private fetcher(): ResearchFetcher {
    return async (request) => {
      this.requests.push(`GET ${request.url}`);
      const recorded = this.http.get(request.url);
      if (!recorded) {
        return { url: request.url, status: 404, contentType: "text/plain", body: `no recording for ${request.url}`, bytes: 0, truncated: false, headers: {} };
      }
      return {
        url: recorded.url,
        status: recorded.status ?? 200,
        ...(recorded.contentType !== undefined ? { contentType: recorded.contentType } : {}),
        body: recorded.body,
        bytes: Buffer.byteLength(recorded.body, "utf8"),
        truncated: false,
        headers: { "content-type": recorded.contentType ?? "text/html" },
      };
    };
  }

  private webSearch() {
    return async (query: string): Promise<string> => {
      this.requests.push(`SEARCH ${query}`);
      const recorded = this.searches.get(query.trim().toLowerCase());
      if (!recorded) return JSON.stringify({ provider: "recorded", answer: "", results: [] });
      return recorded;
    };
  }

  private runner(): ProcessRunner {
    return async (command, args) => {
      const key = [command, ...args].join(" ");
      this.requests.push(key);
      const recorded = this.git.get(args.join(" "));
      if (recorded) return recorded;
      return { code: 1, stdout: "", stderr: `no recording for: ${key}`, spawned: true, timedOut: false };
    };
  }

  // ------------------------------------------------------------- the bridge

  adapters(): ResearchAdapterId[] {
    return this.research.adapters();
  }

  search(input: { adapter: ResearchAdapterId; query: string; limit: number; after?: string; before?: string; cursor?: string }): Promise<ResearchSearchResult> {
    return this.research.search(input);
  }

  read(input: { adapter?: ResearchAdapterId; sourceId: string; offset?: number; limit?: number; paths?: string[] }): Promise<ResearchReadResult> {
    return this.research.read(input);
  }

  artifact(ref?: string): Promise<ResearchArtifact> {
    return this.research.artifact(ref);
  }

  apply(input: { researchRef: string; expectedRevisionId: string; idempotencyKey: string; operation: ResearchOperation }): Promise<ResearchWriteAck> {
    return this.research.apply(input);
  }

  knownSource(sourceId: string): SourceRef | undefined {
    return this.research.knownSource(sourceId);
  }

  hasRead(sourceId: string): boolean {
    return this.research.hasRead(sourceId);
  }

  budgetLine(): string {
    return this.research.budgetLine();
  }

  dispose(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}
