/**
 * Research: adapter descriptors, settings, budgets and the two write
 * operations (M21-T26, `docs/research-phase.md`, D-351).
 *
 * The body itself lives in `project-work-bodies.ts`. What is here is
 * everything **around** a Research body that both sides of the wire need:
 *
 * - `RESEARCH_ADAPTERS` — one descriptor per adapter: what it reaches, what
 *   it needs to authenticate, how often it may be called, what a search and a
 *   read return, and whether it ships. Settings, the tool schemas and the
 *   Research sources screen are all generated from this list.
 * - `ResearchSources` — the settings shape: per-adapter enable, per-project
 *   allow/deny domain lists, and the four budget numbers.
 * - `ResearchOperation` — what `record_finding` and `resolve_question` send.
 *   A writer does not build a body and post it; it sends one operation, and
 *   `applyResearchOperation()` turns the current body plus the operation into
 *   the next body, refusing everything the contract's "Rules" section
 *   refuses. The worker runs it as a pre-check so a refusal costs no round
 *   trip; the **host runs it as the authority** and stores the result through
 *   `project/work/revise` (D-351.a). Both run the same function, so there is
 *   one place where a rule can be wrong.
 *
 * Nothing here fetches, reads a file or knows what an adapter is made of.
 */
import { z } from "zod";
import {
  RESEARCH_ANSWER_MAX,
  RESEARCH_CLAIM_MAX,
  RESEARCH_EXCERPT_MAX,
  RESEARCH_FINDINGS_MAX,
  RESEARCH_QUESTION_DEPTH_MAX,
  RESEARCH_QUESTION_MAX,
  RESEARCH_QUESTION_NODES_MAX,
  sourceRefSchema,
  type FindingConfidence,
  type ResearchBody,
  type ResearchFinding,
  type ResearchQuestionNode,
  type ResearchQuestionState,
  type ResearchStatus,
  type SourceKind,
  type SourceLicence,
  type SourceRef,
} from "./project-work-bodies.js";

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Every adapter the contract names, in the order its table lists them. */
export const RESEARCH_ADAPTER_IDS = ["web", "project", "repository", "package", "document", "scholarly", "tracker"] as const;
export type ResearchAdapterId = (typeof RESEARCH_ADAPTER_IDS)[number];

/** Where an adapter goes to answer. `project` is local and fenced by project trust. */
export const RESEARCH_REACHES = ["network", "local", "project"] as const;
export type ResearchReach = (typeof RESEARCH_REACHES)[number];

/** What an adapter needs before it can answer at all. */
export const RESEARCH_AUTH_KINDS = ["none", "provider_key", "person_credential", "project_trust", "local"] as const;
export type ResearchAuthKind = (typeof RESEARCH_AUTH_KINDS)[number];

/**
 * How often an adapter may be called, and whether a robots policy applies.
 * The ceilings are the adapter's own; the run's budget is separate and smaller.
 */
export interface ResearchRatePolicy {
  /** Requests this adapter may make in one minute. */
  maxPerMinute: number;
  /** The smallest gap between two requests, in milliseconds. */
  minIntervalMs: number;
  /** Whether a robots/terms policy governs this adapter's requests. */
  robots: "honoured" | "not_applicable";
}

/** What one adapter is, in the words Settings and the tool schemas both use. */
export interface ResearchAdapterDescriptor {
  id: ResearchAdapterId;
  /** The name a person reads in Settings → Research sources. */
  title: string;
  /** One sentence: what it does. Never names the engine. */
  what: string;
  /** The `SourceRef.kind` its findings carry. */
  sourceKind: SourceKind;
  reach: ResearchReach;
  auth: ResearchAuthKind;
  /** What a person has to do before it works, when `auth` is not `none`. */
  authNote?: string;
  rate: ResearchRatePolicy;
  /** What `search_sources` answers with, and what `read_source` answers with. */
  result: { search: "hits" | "none"; read: "text" | "metadata" | "none" };
  /** `first` ships in this task; `second` is a descriptor only, for now. */
  ships: "first" | "second";
  /** False for a descriptor with no implementation behind it yet. */
  shipped: boolean;
  /** True when it keeps working with no network (the contract's offline rule). */
  offline: boolean;
}

export const RESEARCH_ADAPTERS: readonly ResearchAdapterDescriptor[] = [
  {
    id: "web",
    title: "The web",
    what: "Searches with your own search provider and reads one page at a time as plain text.",
    sourceKind: "web",
    reach: "network",
    auth: "provider_key",
    authNote: "Uses the search provider you connected in Settings; pages themselves are fetched without signing in.",
    rate: { maxPerMinute: 20, minIntervalMs: 1_000, robots: "honoured" },
    result: { search: "hits", read: "text" },
    ships: "first",
    shipped: true,
    offline: false,
  },
  {
    id: "project",
    title: "This project",
    what: "Reads this project's own files, its history and the work it already holds.",
    sourceKind: "project",
    reach: "project",
    auth: "project_trust",
    authNote: "Reads only the project this session is open on.",
    rate: { maxPerMinute: 600, minIntervalMs: 0, robots: "not_applicable" },
    result: { search: "hits", read: "text" },
    ships: "first",
    shipped: true,
    offline: true,
  },
  {
    id: "repository",
    title: "Public repositories",
    what: "Pins a public repository at an exact commit and reads its readme, licence, manifest and named files.",
    sourceKind: "repository",
    reach: "network",
    auth: "none",
    authNote: "Public repositories only. A private one is read with the credentials you already use for that host.",
    rate: { maxPerMinute: 10, minIntervalMs: 2_000, robots: "not_applicable" },
    result: { search: "hits", read: "text" },
    ships: "first",
    shipped: true,
    offline: false,
  },
  {
    id: "package",
    title: "Package registries",
    what: "Reads published package metadata: versions, licence, dependencies and the repository a package declares.",
    sourceKind: "package",
    reach: "network",
    auth: "none",
    rate: { maxPerMinute: 20, minIntervalMs: 500, robots: "honoured" },
    result: { search: "hits", read: "metadata" },
    ships: "first",
    shipped: true,
    offline: false,
  },
  {
    id: "document",
    title: "Files you provide",
    what: "Reads a file you attached or a path inside this project as bounded text.",
    sourceKind: "document",
    reach: "local",
    auth: "local",
    rate: { maxPerMinute: 600, minIntervalMs: 0, robots: "not_applicable" },
    result: { search: "hits", read: "text" },
    ships: "first",
    shipped: true,
    offline: true,
  },
  {
    id: "scholarly",
    title: "Scholarly indexes",
    what: "Searches open scholarly indexes and resolves a DOI to the work it names.",
    sourceKind: "scholarly",
    reach: "network",
    auth: "none",
    rate: { maxPerMinute: 10, minIntervalMs: 2_000, robots: "honoured" },
    result: { search: "hits", read: "metadata" },
    ships: "second",
    shipped: false,
    offline: false,
  },
  {
    id: "tracker",
    title: "Issues and pull requests",
    what: "Reads issues and pull requests on a repository's host, without writing anything.",
    sourceKind: "repository",
    reach: "network",
    auth: "person_credential",
    authNote: "Uses the host credentials you already connected for source control.",
    rate: { maxPerMinute: 10, minIntervalMs: 2_000, robots: "not_applicable" },
    result: { search: "hits", read: "text" },
    ships: "second",
    shipped: false,
    offline: false,
  },
];

const ADAPTERS_BY_ID = new Map(RESEARCH_ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function researchAdapter(id: ResearchAdapterId): ResearchAdapterDescriptor {
  const adapter = ADAPTERS_BY_ID.get(id);
  if (!adapter) throw new Error(`no research adapter called ${id}`);
  return adapter;
}

/** The adapters with an implementation behind them, in contract order. */
export const SHIPPED_RESEARCH_ADAPTERS: readonly ResearchAdapterId[] = RESEARCH_ADAPTERS.filter((adapter) => adapter.shipped).map(
  (adapter) => adapter.id,
);

/** What the product cannot do yet, in the sentence a person and a model both read. */
export const RESEARCH_GAPS = {
  pdf: "PDF text extraction is not available in this version, so a PDF is not read. Export the pages you need as text or Markdown and attach that, or give the passage in the conversation.",
  scholarly: "Scholarly indexes are not connected in this version.",
  tracker: "Issues and pull requests are not read in this version.",
} as const;

// ---------------------------------------------------------------------------
// Settings (Settings → Research sources)
// ---------------------------------------------------------------------------

/** The one top-level settings key Research owns. */
export const RESEARCH_SETTING_KEY = "research";

/** One research run's ceilings. Defaults are settings; a run may lower them. */
export interface ResearchBudget {
  maxSearches: number;
  maxReads: number;
  /** Total bytes fetched and read, across every adapter. */
  maxBytes: number;
  /** Wall clock for the whole run. */
  maxWallClockMs: number;
}

export const RESEARCH_BUDGET_DEFAULTS: ResearchBudget = {
  maxSearches: 24,
  maxReads: 32,
  maxBytes: 4 * 1024 * 1024,
  maxWallClockMs: 15 * 60_000,
};

/** Ceilings on the ceilings, so a settings file cannot ask for an unbounded run. */
export const RESEARCH_BUDGET_MAX: ResearchBudget = {
  maxSearches: 200,
  maxReads: 200,
  maxBytes: 64 * 1024 * 1024,
  maxWallClockMs: 2 * 60 * 60_000,
};

/** The per-project research cache quota the host enforces, in bytes. */
export const RESEARCH_CACHE_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const RESEARCH_CACHE_MAX_BYTES = 512 * 1024 * 1024;

/** The largest single body an adapter will hold, before ranged reads. */
export const RESEARCH_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
/** The largest page one `read_source` call returns. */
export const RESEARCH_READ_PAGE_MAX_BYTES = 16 * 1024;
/** The most hits one `search_sources` call returns. */
export const RESEARCH_SEARCH_LIMIT_MAX = 20;

export interface ResearchSources {
  /** Per-adapter enable. An adapter that does not ship is always off. */
  adapters: Record<ResearchAdapterId, boolean>;
  /** Hosts the `web` adapter may reach. Empty means "every host that is not denied". */
  allowDomains: string[];
  /** Hosts the `web` adapter may never reach. Deny wins over allow. */
  denyDomains: string[];
  budget: ResearchBudget;
  /** The per-project cache quota. The host owns the number; the worker evicts to it. */
  cacheMaxBytes: number;
}

const DEFAULT_ENABLED: Record<ResearchAdapterId, boolean> = Object.fromEntries(
  RESEARCH_ADAPTER_IDS.map((id) => [id, researchAdapter(id).shipped]),
) as Record<ResearchAdapterId, boolean>;

export function defaultResearchSources(): ResearchSources {
  return {
    adapters: { ...DEFAULT_ENABLED },
    allowDomains: [],
    denyDomains: [],
    budget: { ...RESEARCH_BUDGET_DEFAULTS },
    cacheMaxBytes: RESEARCH_CACHE_DEFAULT_MAX_BYTES,
  };
}

const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^\*?\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i, "a host name, optionally with a leading dot for its subdomains");

export const researchSourcesSchema = z
  .object({
    adapters: z.record(z.enum(RESEARCH_ADAPTER_IDS), z.boolean()).optional(),
    allowDomains: z.array(domain).max(200).optional(),
    denyDomains: z.array(domain).max(200).optional(),
    budget: z
      .object({
        maxSearches: z.number().int().min(1).max(RESEARCH_BUDGET_MAX.maxSearches).optional(),
        maxReads: z.number().int().min(1).max(RESEARCH_BUDGET_MAX.maxReads).optional(),
        maxBytes: z.number().int().min(1024).max(RESEARCH_BUDGET_MAX.maxBytes).optional(),
        maxWallClockMs: z.number().int().min(1000).max(RESEARCH_BUDGET_MAX.maxWallClockMs).optional(),
      })
      .strict()
      .optional(),
    cacheMaxBytes: z.number().int().min(1024 * 1024).max(RESEARCH_CACHE_MAX_BYTES).optional(),
  })
  .strict();

/**
 * The settings as the worker uses them: defaults, then whatever the document
 * says that survives validation.
 *
 * Tolerant on purpose. A settings file with one bad field must not turn every
 * adapter off; the field is ignored and the rest of the document still counts.
 */
export function readResearchSources(value: unknown): ResearchSources {
  const sources = defaultResearchSources();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return sources;
  const parsed = researchSourcesSchema.safeParse(value);
  const raw = (parsed.success ? parsed.data : partialResearchSources(value as Record<string, unknown>)) ?? {};
  for (const [id, enabled] of Object.entries(raw.adapters ?? {})) {
    if (typeof enabled !== "boolean") continue;
    if (!(RESEARCH_ADAPTER_IDS as readonly string[]).includes(id)) continue;
    sources.adapters[id as ResearchAdapterId] = enabled;
  }
  if (raw.allowDomains) sources.allowDomains = raw.allowDomains.map(normaliseDomain);
  if (raw.denyDomains) sources.denyDomains = raw.denyDomains.map(normaliseDomain);
  if (raw.budget) {
    for (const [name, number] of Object.entries(raw.budget)) {
      if (typeof number === "number") sources.budget[name as keyof ResearchBudget] = number;
    }
  }
  if (raw.cacheMaxBytes !== undefined) sources.cacheMaxBytes = raw.cacheMaxBytes;
  // An adapter with nothing behind it is off however the document reads.
  for (const id of RESEARCH_ADAPTER_IDS) if (!researchAdapter(id).shipped) sources.adapters[id] = false;
  return sources;
}

/** Field-by-field salvage of a document the whole-object parse rejected. */
function partialResearchSources(value: Record<string, unknown>): z.infer<typeof researchSourcesSchema> {
  const out: Record<string, unknown> = {};
  for (const key of ["adapters", "allowDomains", "denyDomains", "budget", "cacheMaxBytes"] as const) {
    if (!(key in value)) continue;
    const one = researchSourcesSchema.safeParse({ [key]: value[key] });
    if (one.success) Object.assign(out, one.data);
    else if (key === "budget" && typeof value[key] === "object" && value[key] !== null) {
      // One impossible budget number must not discard the other three.
      const budget: Record<string, number> = {};
      for (const [name, number] of Object.entries(value[key] as Record<string, unknown>)) {
        const probe = researchSourcesSchema.safeParse({ budget: { [name]: number } });
        if (probe.success && probe.data.budget) Object.assign(budget, probe.data.budget);
      }
      if (Object.keys(budget).length > 0) out["budget"] = budget;
    } else if (key === "adapters" && typeof value[key] === "object" && value[key] !== null) {
      const adapters: Record<string, boolean> = {};
      for (const [name, enabled] of Object.entries(value[key] as Record<string, unknown>)) {
        if (typeof enabled === "boolean" && (RESEARCH_ADAPTER_IDS as readonly string[]).includes(name)) adapters[name] = enabled;
      }
      if (Object.keys(adapters).length > 0) out["adapters"] = adapters;
    } else if ((key === "allowDomains" || key === "denyDomains") && Array.isArray(value[key])) {
      const list = (value[key] as unknown[]).filter((entry): entry is string => domain.safeParse(entry).success);
      if (list.length > 0) out[key] = list;
    }
  }
  return out as z.infer<typeof researchSourcesSchema>;
}

function normaliseDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*/, "").replace(/^\./, "");
}

/** Whether this adapter may be used at all. A disabled adapter's tool is absent. */
export function researchAdapterEnabled(sources: ResearchSources, id: ResearchAdapterId): boolean {
  return researchAdapter(id).shipped && sources.adapters[id] === true;
}

/** The enabled adapters, in contract order. */
export function enabledResearchAdapters(sources: ResearchSources): ResearchAdapterId[] {
  return RESEARCH_ADAPTER_IDS.filter((id) => researchAdapterEnabled(sources, id));
}

/**
 * Whether a host may be reached, and the sentence to say when it may not.
 * Deny wins; an allow list, once non-empty, is exhaustive.
 */
export function researchHostAllowed(sources: ResearchSources, host: string): { allowed: boolean; reason?: string } {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (name === "") return { allowed: false, reason: "That address has no host name." };
  const matches = (pattern: string): boolean => name === pattern || name.endsWith(`.${pattern}`);
  if (sources.denyDomains.some(matches)) {
    return { allowed: false, reason: `${name} is on this project's list of hosts research must not reach.` };
  }
  if (sources.allowDomains.length > 0 && !sources.allowDomains.some(matches)) {
    return {
      allowed: false,
      reason: `This project limits research to ${sources.allowDomains.slice(0, 5).join(", ")}${sources.allowDomains.length > 5 ? " and others" : ""}, and ${name} is not one of them.`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// The two write operations
// ---------------------------------------------------------------------------

export const RESEARCH_OPERATIONS = ["record_finding", "resolve_question"] as const;
export type ResearchOperationKind = (typeof RESEARCH_OPERATIONS)[number];

/** What `record_finding` sends. One claim, one source, one moment. */
export interface RecordFindingOperation {
  op: "record_finding";
  questionId: string;
  claim: string;
  /** What the caller believes. The rule decides; a mismatch is refused. */
  confidence: FindingConfidence;
  source: SourceRef;
  excerpt?: string;
  location?: { path: string; from?: number; to?: number };
  licence: SourceLicence;
  reuse?: { what: "code" | "concept" | "asset" | "api"; from: string; notes?: string };
  /** Spec/Design decisions this finding backs. */
  supports?: string[];
  /** Findings this one contradicts. A correction is a new finding, never an edit. */
  contradicts?: string[];
  /** The findings an `inferred` claim rests on. Two or more (D-351.b). */
  derivedFrom?: string[];
  /** When it was read. The host may overwrite it with its own clock. */
  retrievedAt?: string;
}

/** What `resolve_question` sends. */
export interface ResolveQuestionOperation {
  op: "resolve_question";
  questionId: string;
  state: ResearchQuestionState;
  answer?: string;
  /** The findings the answer cites. */
  findings?: string[];
  /** Said outright when an answer rests on inference alone. */
  inferredOnly?: boolean;
  /** Required for `unanswerable`: what would settle it. */
  wouldSettleIt?: string;
  /** New sub-questions to open, with the resolved one as their parent. */
  addQuestions?: Array<{ id?: string; text: string }>;
}

export type ResearchOperation = RecordFindingOperation | ResolveQuestionOperation;

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "an id this app minted");

export const recordFindingOperationSchema = z
  .object({
    op: z.literal("record_finding"),
    questionId: opaqueId,
    claim: z.string().min(1).max(RESEARCH_CLAIM_MAX),
    confidence: z.enum(["declared", "observed", "inferred", "proposed"]),
    source: sourceRefSchema,
    excerpt: z.string().max(RESEARCH_EXCERPT_MAX).optional(),
    location: z
      .object({ path: z.string().min(1).max(1024), from: z.number().int().nonnegative().optional(), to: z.number().int().nonnegative().optional() })
      .strict()
      .optional(),
    licence: z.enum(["permissive", "copyleft", "proprietary", "unknown", "not_applicable"]),
    reuse: z
      .object({ what: z.enum(["code", "concept", "asset", "api"]), from: z.string().min(1).max(2048), notes: z.string().max(1000).optional() })
      .strict()
      .optional(),
    supports: z.array(z.string().min(1).max(200)).max(32).optional(),
    contradicts: z.array(opaqueId).max(32).optional(),
    derivedFrom: z.array(opaqueId).max(32).optional(),
    retrievedAt: z.string().min(1).max(64).optional(),
  })
  .strict();

export const resolveQuestionOperationSchema = z
  .object({
    op: z.literal("resolve_question"),
    questionId: opaqueId,
    state: z.enum(["open", "answered", "unanswerable", "handed_to_person"]),
    answer: z.string().max(RESEARCH_ANSWER_MAX).optional(),
    findings: z.array(opaqueId).max(RESEARCH_FINDINGS_MAX).optional(),
    inferredOnly: z.boolean().optional(),
    wouldSettleIt: z.string().min(1).max(1000).optional(),
    addQuestions: z
      .array(z.object({ id: opaqueId.optional(), text: z.string().min(1).max(RESEARCH_QUESTION_MAX) }).strict())
      .max(16)
      .optional(),
  })
  .strict();

export const researchOperationSchema = z.discriminatedUnion("op", [recordFindingOperationSchema, resolveQuestionOperationSchema]);

/** What a session really read, as the side applying the operation knows it. */
export interface ResearchSessionRead {
  /** The digest of the bytes that were fetched. */
  digest: string;
  /** The readable text the session was given, for the excerpt check. */
  text: string;
  /** The canonical identity the text came back under. */
  canonical?: string;
}

/**
 * What a session read from one source: one read, or several when the source
 * was read in pieces (a repository read file by file, a long page read page by
 * page). An excerpt may come from any of them.
 */
export type ResearchSessionReads = ResearchSessionRead | readonly ResearchSessionRead[];

export interface ResearchOperationContext {
  /** What this session read, keyed by `SourceRef.id`. */
  reads?: ReadonlyMap<string, ResearchSessionReads> | Record<string, ResearchSessionReads>;
  /** The clock. The host's, not the model's. */
  now?: () => Date;
  /** Mints a finding or question id. Deterministic in tests. */
  mintId?: (prefix: "f" | "q") => string;
}

/** A refused operation, in the tool contract's own shape. Nothing is applied. */
export class ResearchOperationRefused extends Error {
  readonly code: string;
  readonly next: string;
  readonly committed = false;
  constructor(code: string, message: string, next: string) {
    super(message);
    this.name = "ResearchOperationRefused";
    this.code = code;
    this.next = next;
  }
}

export interface ResearchAttention {
  kind: "handed_to_person";
  questionId: string;
  /** The question, in the person's words. */
  text: string;
  /** What the agent got to before it handed it over. */
  note?: string;
}

export interface ResearchOperationResult {
  /** The body to store. Never a partial application: a refusal throws. */
  body: ResearchBody;
  /** The finding a `record_finding` appended. */
  findingId?: string;
  questionId: string;
  /** Present when the write hands a question to a person. */
  attention?: ResearchAttention;
  /**
   * Spec/Design decisions a superseded finding backed. The host marks these
   * stale (leap stale propagation): a Research revision that changes a finding
   * a decision cites stales that decision.
   */
  staleRefs: string[];
  /** Said when a `reuse` was recorded but its licence blocks recommending it. */
  reuseBlocked?: string;
  /** The rule's verdict, when the caller's `confidence` needed explaining. */
  confidenceNote?: string;
}

const CONFIDENCE_NEXT = "call record_finding again with the confidence the rule allows for this source, or read a primary source first";

/**
 * The confidence rule (`docs/research-phase.md`, "Rules"), as a check.
 *
 * It is deliberately not "what the model said": `declared` needs an official
 * or primary source and a verbatim excerpt, `observed` needs this project,
 * `inferred` needs two findings under it, and `proposed` means nothing has
 * been fetched yet.
 */
export function checkFindingConfidence(
  operation: RecordFindingOperation,
  existing: ReadonlyMap<string, ResearchFinding>,
): { ok: true } | { ok: false; code: string; message: string } {
  const { confidence, source } = operation;
  if (confidence === "declared") {
    // The person/session case first: its sentence explains the rule, where the
    // trust one would only report a level.
    if (source.kind === "person" || source.kind === "session") {
      return {
        ok: false,
        code: "confidence_not_declared",
        message: "What a person said or an earlier session concluded is secondary evidence, so it cannot be declared. Record it as proposed, and cite the source it came from when you find it.",
      };
    }
    if (source.trust !== "official" && source.trust !== "primary") {
      return {
        ok: false,
        code: "confidence_not_declared",
        message: `A declared finding quotes an official or primary source, and this one is ${source.trust}. Record it as an inferred or proposed claim, or find the primary source that states it.`,
      };
    }
    if (!operation.excerpt || operation.excerpt.trim() === "") {
      return { ok: false, code: "excerpt_required", message: "A declared finding quotes the source verbatim, and this call carried no excerpt." };
    }
    return { ok: true };
  }
  if (confidence === "observed") {
    if (source.kind !== "project") {
      return {
        ok: false,
        code: "confidence_not_observed",
        message: `An observed finding is something read or run in this project, and this source is a ${source.kind} source. Record it as declared if it is primary, or as inferred.`,
      };
    }
    if (!operation.excerpt && !operation.location) {
      return { ok: false, code: "excerpt_required", message: "An observed finding says where it was seen: pass the excerpt you read, or the path and line range." };
    }
    return { ok: true };
  }
  if (confidence === "inferred") {
    const from = operation.derivedFrom ?? [];
    if (from.length < 2) {
      return {
        ok: false,
        code: "inference_uncited",
        message: "An inferred finding is derived from at least two findings and cites them. Pass derivedFrom with the ids of the findings it rests on.",
      };
    }
    const missing = from.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      return { ok: false, code: "no_such_finding", message: `This research has no finding called ${missing.join(", ")}.` };
    }
    return { ok: true };
  }
  // `proposed` is where a claim lands when no official or primary source
  // states it: nothing fetched at all, or only a secondary or community
  // source asserting it. What it may never be is a primary source the agent
  // read and then declined to quote.
  if (source.trust === "official" || source.trust === "primary") {
    return {
      ok: false,
      code: "confidence_not_proposed",
      message: "A proposed claim has no source behind it yet, and this one names a primary source. Read the source and record what it declares.",
    };
  }
  return { ok: true };
}

function readsOf(context: ResearchOperationContext | undefined, sourceId: string): ResearchSessionRead[] {
  const reads = context?.reads;
  if (!reads) return [];
  const entry = reads instanceof Map ? reads.get(sourceId) : (reads as Record<string, ResearchSessionReads | undefined>)[sourceId];
  if (!entry) return [];
  return Array.isArray(entry) ? [...entry] : [entry as ResearchSessionRead];
}

/** Whitespace-insensitive containment: a quote is still a quote after re-wrapping. */
function containsExcerpt(text: string, excerpt: string): boolean {
  const flatten = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
  return flatten(text).includes(flatten(excerpt));
}

/** The body's `status`, derived from its question states. Never sent by a client. */
export function researchStatusFrom(questions: readonly ResearchQuestionNode[], current?: ResearchStatus): ResearchStatus {
  if (current === "superseded") return "superseded";
  if (questions.length === 0) return "open";
  const open = questions.filter((question) => question.state === "open").length;
  const answered = questions.filter((question) => question.state === "answered").length;
  const unanswerable = questions.filter((question) => question.state === "unanswerable").length;
  if (open === questions.length) return "open";
  if (answered === questions.length) return "answered";
  if (unanswerable === questions.length) return "unanswerable";
  if (open > 0) return "open";
  // Nothing is open, and it is neither all answered nor all unanswerable.
  return "partial";
}

function refuse(code: string, message: string, next: string): never {
  throw new ResearchOperationRefused(code, message, next);
}

function depthOf(questions: readonly ResearchQuestionNode[], id: string): number {
  const byId = new Map(questions.map((question) => [question.id, question]));
  let depth = 0;
  let cursor = byId.get(id)?.parent;
  const seen = new Set<string>([id]);
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parent;
  }
  return depth;
}

/**
 * Apply one operation to one body.
 *
 * Pure: it never fetches, never writes and never mutates its input. Every
 * refusal is a `ResearchOperationRefused` carrying the code, the sentence a
 * person reads and the next call to make. The host runs this as the authority
 * (D-351.a); the worker runs it first so a refusal costs no round trip.
 */
export function applyResearchOperation(
  body: ResearchBody,
  operation: ResearchOperation,
  context: ResearchOperationContext = {},
): ResearchOperationResult {
  const parsed = researchOperationSchema.safeParse(operation);
  if (!parsed.success) {
    refuse(
      "invalid_operation",
      `That write does not match what a research write may say: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}.`,
      "call the tool again with the fields its schema declares",
    );
  }
  const now = context.now?.() ?? new Date();
  const questions = body.questions.map((question) => ({ ...question, findings: [...question.findings] }));
  const findings = [...body.findings];
  const byFindingId = new Map(findings.map((finding) => [finding.id, finding]));
  const question = questions.find((candidate) => candidate.id === operation.questionId);
  if (!question) {
    refuse(
      "no_such_question",
      `This research has no question called "${operation.questionId}".`,
      "call inspect_project_work on this research to read its question tree with the ids",
    );
  }

  if (operation.op === "record_finding") {
    return recordFinding(body, operation, { questions, findings, byFindingId, question, now, context });
  }
  return resolveQuestion(body, operation, { questions, findings, byFindingId, question, now, context });
}

interface ApplyState {
  questions: ResearchQuestionNode[];
  findings: ResearchFinding[];
  byFindingId: Map<string, ResearchFinding>;
  question: ResearchQuestionNode;
  now: Date;
  context: ResearchOperationContext;
}

function mint(context: ResearchOperationContext, prefix: "f" | "q", taken: ReadonlySet<string>): string {
  if (context.mintId) {
    const id = context.mintId(prefix);
    if (!taken.has(id)) return id;
  }
  let index = taken.size + 1;
  let id = `${prefix}${String(index)}`;
  while (taken.has(id)) {
    index += 1;
    id = `${prefix}${String(index)}`;
  }
  return id;
}

function recordFinding(body: ResearchBody, operation: RecordFindingOperation, state: ApplyState): ResearchOperationResult {
  const { questions, findings, byFindingId, question, now, context } = state;
  if (findings.length >= RESEARCH_FINDINGS_MAX) {
    refuse(
      "research_full",
      `This research already holds ${String(RESEARCH_FINDINGS_MAX)} findings, which is as many as one research may hold.`,
      "resolve the open questions with the findings you have, or start a new research for what remains",
    );
  }
  const verdict = checkFindingConfidence(operation, byFindingId);
  if (!verdict.ok) refuse(verdict.code, verdict.message, CONFIDENCE_NEXT);

  const contradicts = operation.contradicts ?? [];
  const unknownContradiction = contradicts.filter((id) => !byFindingId.has(id));
  if (unknownContradiction.length > 0) {
    refuse(
      "no_such_finding",
      `This research has no finding called ${unknownContradiction.join(", ")}, so nothing can contradict it.`,
      "call inspect_project_work on this research to read its findings with their ids",
    );
  }

  // The excerpt-in-digest check: when this session read the source, the
  // excerpt has to be in what it read. A quote nobody fetched is not a quote.
  // A source read in pieces is checked against every piece.
  const sessionReads = readsOf(context, operation.source.id);
  if (sessionReads.length > 0 && operation.excerpt && !sessionReads.some((read) => containsExcerpt(read.text, operation.excerpt!))) {
    refuse(
      "excerpt_not_in_source",
      "That excerpt is not in the text this session read from that source, so it cannot be recorded as a quote from it.",
      "call read_source again for the passage and copy the excerpt from what it returns",
    );
  }
  if (sessionReads.length > 0 && operation.source.digest !== undefined && !sessionReads.some((read) => read.digest === operation.source.digest)) {
    refuse(
      "digest_mismatch",
      "The source digest in this call is not the digest of anything this session read from that source, so the excerpt cannot be checked against it.",
      "call read_source again and record the finding with the digest it returns",
    );
  }
  const read = sessionReads.at(-1);

  const id = mint(context, "f", new Set(findings.map((finding) => finding.id)));
  const finding: ResearchFinding = {
    id,
    claim: operation.claim,
    confidence: operation.confidence,
    source: read?.digest !== undefined && operation.source.digest === undefined ? { ...operation.source, digest: read.digest } : { ...operation.source },
    ...(operation.excerpt !== undefined ? { excerpt: operation.excerpt } : {}),
    ...(operation.location !== undefined ? { location: operation.location } : {}),
    retrievedAt: operation.retrievedAt ?? now.toISOString(),
    licence: operation.licence,
    ...(operation.reuse !== undefined ? { reuse: operation.reuse } : {}),
    supports: operation.supports ?? [],
    contradicts,
    ...(operation.derivedFrom !== undefined ? { derivedFrom: operation.derivedFrom } : {}),
  };
  findings.push(finding);
  if (!question.findings.includes(id)) question.findings.push(id);

  // Stale propagation: a finding that contradicts one a decision cites means
  // that decision now rests on something this research has corrected.
  const staleRefs = [...new Set(contradicts.flatMap((old) => byFindingId.get(old)?.supports ?? []))];

  const sources = dedupeSources([...body.sources, finding.source]);
  const reuseBlocked =
    finding.reuse && (finding.licence === "unknown" || finding.licence === "proprietary")
      ? `This reuse is recorded, but a ${finding.licence} licence blocks recommending it: say so wherever it is proposed, and find the licence before anyone copies from it.`
      : undefined;

  return {
    body: { ...body, questions, findings, sources, status: researchStatusFrom(questions, body.status) },
    findingId: id,
    questionId: question.id,
    staleRefs,
    ...(reuseBlocked !== undefined ? { reuseBlocked } : {}),
  };
}

function resolveQuestion(body: ResearchBody, operation: ResolveQuestionOperation, state: ApplyState): ResearchOperationResult {
  const { questions, findings, byFindingId, question, context } = state;
  const cited = operation.findings ?? question.findings;
  const unknown = cited.filter((id) => !byFindingId.has(id));
  if (unknown.length > 0) {
    refuse(
      "no_such_finding",
      `This research has no finding called ${unknown.join(", ")}.`,
      "call inspect_project_work on this research to read its findings with their ids, then resolve the question again",
    );
  }

  if (operation.state === "answered") {
    if (!operation.answer || operation.answer.trim() === "") {
      refuse("answer_required", "An answered question carries the answer itself, and this call had none.", "call resolve_question again with the answer text");
    }
    const strong = cited.map((id) => byFindingId.get(id)!).filter((finding) => finding.confidence === "declared" || finding.confidence === "observed");
    if (strong.length === 0 && operation.inferredOnly !== true) {
      refuse(
        "citation_required",
        "An answered question cites at least one declared or observed finding. This answer cites none, so either record the finding that settles it, or resolve it again saying outright that it rests on inference alone.",
        "call record_finding for the source that states it, then resolve_question again with that finding — or pass inferredOnly: true",
      );
    }
  }
  if (operation.state === "unanswerable" && (!operation.wouldSettleIt || operation.wouldSettleIt.trim() === "")) {
    refuse(
      "would_settle_required",
      "A question marked unanswerable says what would settle it, so a person knows what to go and find.",
      "call resolve_question again with wouldSettleIt naming the source, test or decision that would answer it",
    );
  }

  const resolved: ResearchQuestionNode = {
    ...question,
    state: operation.state,
    findings: cited,
    ...(operation.answer !== undefined ? { answer: operation.answer } : {}),
    ...(operation.inferredOnly !== undefined ? { inferredOnly: operation.inferredOnly } : {}),
  };
  const index = questions.findIndex((candidate) => candidate.id === question.id);
  questions[index] = resolved;

  const added = operation.addQuestions ?? [];
  if (added.length > 0) {
    if (questions.length + added.length > RESEARCH_QUESTION_NODES_MAX) {
      refuse(
        "tree_full",
        `A research holds at most ${String(RESEARCH_QUESTION_NODES_MAX)} questions, and these would take it past that.`,
        "resolve the questions already open before opening more",
      );
    }
    if (depthOf(questions, question.id) + 1 >= RESEARCH_QUESTION_DEPTH_MAX) {
      refuse(
        "tree_too_deep",
        `The question tree is ${String(RESEARCH_QUESTION_DEPTH_MAX)} levels deep at most, and a sub-question here would be deeper.`,
        "open the sub-question higher up the tree, or start a research of its own for it",
      );
    }
    for (const entry of added) {
      const id = entry.id ?? mint(context, "q", new Set(questions.map((candidate) => candidate.id)));
      if (questions.some((candidate) => candidate.id === id)) {
        refuse("duplicate_question", `This research already has a question called "${id}".`, "call resolve_question again without naming an id, and one will be minted");
      }
      questions.push({ id, text: entry.text, parent: question.id, state: "open", findings: [] });
    }
  }

  const attention: ResearchAttention | undefined =
    operation.state === "handed_to_person"
      ? {
          kind: "handed_to_person",
          questionId: question.id,
          text: question.text,
          ...(operation.answer !== undefined ? { note: operation.answer } : {}),
        }
      : undefined;

  const unresolved = [...body.unresolved];
  if (operation.state === "unanswerable" && operation.wouldSettleIt) {
    const fact = question.text.slice(0, 500);
    if (!unresolved.some((entry) => entry.fact === fact)) unresolved.push({ fact, wouldSettleIt: operation.wouldSettleIt });
  }

  // A resolution that cites a finding which contradicts an older one carries
  // the same stale propagation a correction does.
  const staleRefs = [
    ...new Set(
      cited
        .map((id) => byFindingId.get(id)!)
        .flatMap((finding) => finding.contradicts)
        .flatMap((old) => byFindingId.get(old)?.supports ?? []),
    ),
  ];

  return {
    body: {
      ...body,
      questions,
      findings,
      unresolved,
      status: researchStatusFrom(questions, body.status),
      sources: body.sources,
    },
    questionId: question.id,
    staleRefs,
    ...(attention !== undefined ? { attention } : {}),
  };
}

/** One entry per `kind + id`; the newest title and digest win. */
export function dedupeSources(sources: readonly SourceRef[]): SourceRef[] {
  const byKey = new Map<string, SourceRef>();
  for (const source of sources) {
    const key = `${source.kind}\u0000${source.id}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, ...source } : source);
  }
  return [...byKey.values()].slice(0, RESEARCH_FINDINGS_MAX);
}
