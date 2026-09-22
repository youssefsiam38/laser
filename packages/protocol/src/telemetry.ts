/**
 * Whole-session telemetry (source-control leap L3 / D-309).
 *
 * The UI asks for exactly the numbers it renders. Both authorities — the
 * worker while a session is live, the host when it is not — compute them over
 * **every** record in the file with this fold, then stamp the revision they
 * were computed at. A section the caller did not ask for is absent, not empty.
 *
 * The `files` section is not defined here. Changed files come from git
 * (Part E / L2), never from this query.
 */
import type { AccountUsageState } from "./pi-extension.js";

export const TELEMETRY_SECTIONS = ["context", "spend", "model", "work", "history"] as const;
export type TelemetrySection = (typeof TELEMETRY_SECTIONS)[number];

export type TelemetryScope = "session" | "turn";

/** Ranked tool histogram: this many named rows, then an `other` bucket. */
export const TELEMETRY_TOOL_HISTOGRAM_TOP = 8;

/** Sparkline series cap. Full turn arrays are downsampled to this many points. */
export const TELEMETRY_SERIES_MAX = 64;

/** Independent transport bounds for one host-canonical child-spend snapshot. */
export const TELEMETRY_CHILD_SOURCE_MAX = 512;
export const TELEMETRY_CHILD_MODEL_LINE_MAX = 128;
export const TELEMETRY_CHILD_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export type SessionBillingMode = "api" | "account" | "mixed" | "none";

export function isAccountProvider(provider: string | undefined): boolean {
  return provider === "openai-codex" || /^openai-codex-\d+$/.test(provider ?? "");
}

export interface TelemetryUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Assistant turns that reported usage. */
  turns: number;
}

export interface TelemetryModelLine {
  model: string;
  input: number;
  output: number;
  cost: number;
}

export interface TelemetryContext {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  /**
   * Token **estimates** for the live request the engine assembled (tools /
   * chat / thinking / system), using Pi's chars/4 estimator on that payload.
   * Absent when that request has not been observed. Never guessed from the
   * transcript (spec C.4). The figure is an estimate, not a billed count.
   */
  composition?: {
    tools: number;
    chat: number;
    thinking: number;
    system: number;
  };
  autoCompact: {
    enabled: boolean;
    thresholdTokens?: number;
    state: "off" | "idle" | "compacting";
  };
}

export interface TelemetrySpendCoverage {
  /** Distinct descendant session paths still represented by the host run registry. */
  knownChildren: number;
  /** Registry-known children whose spend contributed to this response. */
  includedChildren: number;
  /** Registry-known children omitted because their data or bounded projection was unavailable. */
  unavailableChildren: number;
}

export interface TelemetrySpend {
  billing: SessionBillingMode;
  /** Present on current session-scope responses; absence is fixture compatibility only. */
  coverage?: TelemetrySpendCoverage;
  /**
   * API-billed totals. Absent when there is no API cost — a session with no
   * API spend is one line (`billing`), not five empty meters.
   */
  api?: {
    totals: TelemetryUsageTotals;
    byModel: TelemetryModelLine[];
    /** Cumulative API cost after each API-billed assistant turn, file order. */
    series: number[];
  };
  /** Live account-wide allowance. Absent when the engine is not live. */
  account?: AccountUsageState;
}

export interface TelemetryModel {
  provider?: string;
  id?: string;
  /**
   * The Model Profile this session or run was started on: the intent behind
   * the model beside it (`docs/model-profiles.md`). Per-model usage lines are
   * unchanged — spend is always attributed to the model that was billed.
   * Absent for a pinned session and for a conversation older than profiles.
   */
  profileId?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  contextWindow?: number;
  /** Per-assistant-turn total tokens, file order, for a sparkline. */
  tokenSeries: number[];
}

export interface TelemetryToolRank {
  name: string;
  count: number;
}

export interface TelemetryWork {
  turns: number;
  durationMs: number;
  tools: {
    total: number;
    ranked: TelemetryToolRank[];
    other: number;
    failed: TelemetryToolRank[];
  };
}

/**
 * Whole-session history counts.
 *
 * `records` is the authority's total. How many this client currently holds is
 * the client's own number: it compares `entries.length` (or the loaded page)
 * against `records`. The client does not send a held count — the authority
 * cannot verify it, and the panel already has it.
 */
export interface TelemetryHistory {
  prompts: number;
  records: number;
  compactions: number;
  branches: number;
}

/**
 * Whole-session numbers. Child-run costs are merged from sessions **beneath**
 * the requested path — a child's siblings are not included in that child's spend.
 */
export interface SessionTelemetry {
  revision: string;
  environmentKey: string;
  authority: "live" | "durable";
  scope: TelemetryScope;
  turnId?: string;
  context?: TelemetryContext;
  spend?: TelemetrySpend;
  model?: TelemetryModel;
  work?: TelemetryWork;
  history?: TelemetryHistory;
}

export interface SessionTelemetryParams {
  path: string;
  scope?: TelemetryScope;
  turnId?: string;
  include?: TelemetrySection[];
  environmentKey?: string;
  revision?: string;
}

export interface TelemetryChildSource {
  /** `provider/id` when the run recorded a model. Sets billing even with no usage. */
  model?: string;
  fold?: TelemetryFoldState;
}

/** Only fields consumed while merging child spend; no history/series cross the pipe. */
export interface TelemetryChildSpendFold {
  billingApi: boolean;
  billingAccount: boolean;
  all: TelemetryUsageTotals;
  api: TelemetryUsageTotals;
  byModelAll: TelemetryModelLine[];
  byModelApi: TelemetryModelLine[];
}

export interface TelemetryChildSpendSource {
  /** Internal deduplication identity. Never projected into public telemetry. */
  sessionPath: string;
  /** `provider/id` from the standing run, even when its file is unavailable. */
  model?: string;
  /** Absent means this registry-known child did not contribute spend. */
  spend?: TelemetryChildSpendFold;
}

export interface TelemetryChildSpendSnapshot {
  scopeSessionPath: string;
  generation: number;
  sources: TelemetryChildSpendSource[];
  coverage: TelemetrySpendCoverage;
}

/** The run fields both authorities need to decide which children to fold. */
export interface TelemetryRunRef {
  sessionPath: string;
  rootSessionPath: string;
  parent?: { sessionPath: string } | null;
}

export interface TelemetryLiveOverlay {
  context?: TelemetryContext;
  account?: AccountUsageState;
  model?: {
    provider?: string;
    id?: string;
    profileId?: string;
    thinkingLevel?: TelemetryModel["thinkingLevel"];
    contextWindow?: number;
  };
}

export interface TelemetryFoldState {
  records: number;
  /** Last folded entry id, so a resumed fold can extend a prefix. */
  lastId?: string;
  prompts: number;
  assistantTurns: number;
  usageTurnsAll: number;
  usageTurnsApi: number;
  compactions: number;
  branchSummaries: number;
  forks: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  lastModel: { provider?: string; id?: string; thinkingLevel?: string; contextWindow?: number } | null;
  billingApi: boolean;
  billingAccount: boolean;
  all: TelemetryUsageTotals;
  api: TelemetryUsageTotals;
  byModelAll: Record<string, TelemetryModelLine>;
  byModelApi: Record<string, TelemetryModelLine>;
  costSeries: number[];
  tokenSeries: number[];
  toolCounts: Record<string, number>;
  toolFailed: Record<string, number>;
  childCounts: Record<string, number>;
}

const emptyTotals = (): TelemetryUsageTotals => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, turns: 0,
});

const emptyState = (): TelemetryFoldState => ({
  records: 0,
  prompts: 0,
  assistantTurns: 0,
  usageTurnsAll: 0,
  usageTurnsApi: 0,
  compactions: 0,
  branchSummaries: 0,
  forks: 0,
  firstTimestamp: null,
  lastTimestamp: null,
  lastModel: null,
  billingApi: false,
  billingAccount: false,
  all: emptyTotals(),
  api: emptyTotals(),
  byModelAll: {},
  byModelApi: {},
  costSeries: [],
  tokenSeries: [],
  toolCounts: {},
  toolFailed: {},
  childCounts: {},
});

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const entryId = (entry: unknown): string | undefined => {
  const id = record(entry).id;
  return typeof id === "string" ? id : undefined;
};

const parentIdOf = (entry: unknown): string | null => {
  const parent = record(entry).parentId;
  return typeof parent === "string" ? parent : null;
};

const timestampOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const usageOf = (raw: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number } | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const cost = record(usage.cost);
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: num(usage.totalTokens) || input + output + cacheRead + cacheWrite,
    cost: num(cost.total),
  };
};

function addTotals(into: TelemetryUsageTotals, usage: NonNullable<ReturnType<typeof usageOf>>, asTurn: boolean): void {
  into.input += usage.input;
  into.output += usage.output;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.total += usage.total;
  into.cost += usage.cost;
  if (asTurn) into.turns += 1;
}

function addModelLine(into: Record<string, TelemetryModelLine>, model: string, usage: NonNullable<ReturnType<typeof usageOf>>): void {
  const line = into[model] ?? { model, input: 0, output: 0, cost: 0 };
  line.input += usage.input;
  line.output += usage.output;
  line.cost += usage.cost;
  into[model] = line;
}

function bump(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

function ranked(counts: Record<string, number>, top: number): { ranked: TelemetryToolRank[]; other: number } {
  const rows = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    ranked: rows.slice(0, top),
    other: rows.slice(top).reduce((sum, row) => sum + row.count, 0),
  };
}

function cloneTotals(value: TelemetryUsageTotals): TelemetryUsageTotals {
  return { ...value };
}

export function childSpendFoldOf(fold: TelemetryFoldState): TelemetryChildSpendFold {
  return {
    billingApi: fold.billingApi,
    billingAccount: fold.billingAccount,
    all: cloneTotals(fold.all),
    api: cloneTotals(fold.api),
    byModelAll: Object.values(fold.byModelAll).map((line) => ({ ...line })),
    byModelApi: Object.values(fold.byModelApi).map((line) => ({ ...line })),
  };
}

function cloneLines(value: Record<string, TelemetryModelLine>): Record<string, TelemetryModelLine> {
  return Object.fromEntries(Object.entries(value).map(([key, line]) => [key, { ...line }]));
}

/** One clone of fold state. Index reads use this instead of resume().state. */
export function cloneTelemetryFoldState(state: TelemetryFoldState): TelemetryFoldState {
  return {
    ...state,
    lastModel: state.lastModel ? { ...state.lastModel } : null,
    all: cloneTotals(state.all),
    api: cloneTotals(state.api),
    byModelAll: cloneLines(state.byModelAll),
    byModelApi: cloneLines(state.byModelApi),
    costSeries: [...state.costSeries],
    tokenSeries: [...state.tokenSeries],
    toolCounts: { ...state.toolCounts },
    toolFailed: { ...state.toolFailed },
    childCounts: { ...state.childCounts },
  };
}

function cloneState(state: TelemetryFoldState): TelemetryFoldState {
  return cloneTelemetryFoldState(state);
}

/** Evenly sample `values` down to `max` points so a sparkline stays bounded. */
export function downsampleSeries(values: readonly number[], max = TELEMETRY_SERIES_MAX): number[] {
  if (values.length <= max) return [...values];
  if (max <= 1) return values.length === 0 ? [] : [values[values.length - 1]!];
  const last = values.length - 1;
  const out = new Array<number>(max);
  for (let i = 0; i < max; i++) out[i] = values[Math.round((i * last) / (max - 1))]!;
  return out;
}

/**
 * Runs whose session is a descendant of `sessionPath`. The requested session
 * itself is omitted — it is the fold, not a child source.
 */
export function runsBeneathSession<T extends TelemetryRunRef>(sessionPath: string, runs: readonly T[]): T[] {
  const parentOf = new Map<string, string>();
  for (const run of runs) {
    const parent = run.parent?.sessionPath;
    if (parent && !parentOf.has(run.sessionPath)) parentOf.set(run.sessionPath, parent);
  }
  const beneath = (run: T): boolean => {
    if (run.sessionPath === sessionPath) return false;
    if (run.rootSessionPath === sessionPath) return true;
    let parent = run.parent?.sessionPath;
    const seen = new Set<string>();
    while (parent) {
      if (parent === sessionPath) return true;
      if (seen.has(parent)) break;
      seen.add(parent);
      parent = parentOf.get(parent);
    }
    return false;
  };
  const seen = new Set<string>();
  const children: T[] = [];
  for (const run of runs) {
    if (seen.has(run.sessionPath) || !beneath(run)) continue;
    seen.add(run.sessionPath);
    children.push(run);
  }
  return children;
}

function toolNameOfPart(part: unknown): string | undefined {
  const value = record(part);
  if (value.type !== "toolCall" && value.type !== "toolUse") return undefined;
  const name = value.name ?? value.toolName;
  return typeof name === "string" && name ? name : "unknown";
}

function collectToolCalls(content: unknown, into: Record<string, number>): void {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    const name = toolNameOfPart(part);
    if (name) bump(into, name);
  }
}

function providerOfModel(model: string | undefined): string | undefined {
  return model?.split("/", 1)[0];
}

/**
 * Incremental telemetry fold. Appending costs one walk of the new records,
 * never a re-read of the prefix. `recordsFolded` is the work this instance
 * did — a resumed snapshot that answers from memory reports 0.
 */
export class TelemetryFold {
  private constructor(
    private current: TelemetryFoldState,
    private lastId: string | undefined,
    private folded: number,
  ) {}

  static create(): TelemetryFold {
    return new TelemetryFold(emptyState(), undefined, 0);
  }

  static resume(state: TelemetryFoldState): TelemetryFold {
    return new TelemetryFold(cloneState(state), state.lastId, 0);
  }

  get recordsFolded(): number {
    return this.folded;
  }

  get state(): TelemetryFoldState {
    return cloneState(this.current);
  }

  /** Approximate JS identity bytes of this fold, for the session-index budget. */
  get accountedBytes(): number {
    return 256 + (this.current.costSeries.length + this.current.tokenSeries.length) * 8;
  }

  /**
   * Fold only records after the prefix this instance already saw. A prefix
   * that no longer matches (fork, compaction rewrite) restarts.
   */
  ingest(entries: readonly unknown[]): void {
    const reusable =
      entries.length >= this.current.records &&
      (this.current.records === 0 || entryId(entries[this.current.records - 1]) === this.lastId);
    if (!reusable) {
      this.current = emptyState();
      this.lastId = undefined;
    }
    for (let index = this.current.records; index < entries.length; index++) {
      this.push(entries[index]);
    }
  }

  push(entry: unknown): void {
    this.folded += 1;
    const value = record(entry);
    const type = typeof value.type === "string" ? value.type : "";
    this.current.records += 1;
    const id = entryId(entry);
    this.lastId = id;
    if (id !== undefined) this.current.lastId = id;
    const at = timestampOf(value.timestamp);
    if (at !== null) {
      if (this.current.firstTimestamp === null || at < this.current.firstTimestamp) this.current.firstTimestamp = at;
      if (this.current.lastTimestamp === null || at > this.current.lastTimestamp) this.current.lastTimestamp = at;
    }

    if (type !== "label") {
      const parent = parentIdOf(entry) ?? "";
      const before = this.current.childCounts[parent] ?? 0;
      this.current.childCounts[parent] = before + 1;
      if (before === 1) this.current.forks += 1;
    }

    if (type === "compaction") {
      this.current.compactions += 1;
      this.addUsage(value.usage, false, undefined, undefined);
      return;
    }
    if (type === "branch_summary") {
      this.current.branchSummaries += 1;
      this.addUsage(value.usage, false, undefined, undefined);
      return;
    }
    if (type === "model_change") {
      this.current.lastModel = {
        ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
        ...(typeof value.modelId === "string" ? { id: value.modelId } : {}),
        ...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
      };
      return;
    }
    if (type === "thinking_level_change" && typeof value.thinkingLevel === "string") {
      this.current.lastModel = { ...(this.current.lastModel ?? {}), thinkingLevel: value.thinkingLevel };
      return;
    }
    if (type !== "message") return;

    const message = record(value.message);
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "user") {
      this.current.prompts += 1;
      return;
    }
    if (role === "toolResult") {
      const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "unknown";
      if (message.isError === true) bump(this.current.toolFailed, name);
      return;
    }
    if (role !== "assistant") return;

    this.current.assistantTurns += 1;
    collectToolCalls(message.content, this.current.toolCounts);
    const provider = typeof message.provider === "string" ? message.provider : undefined;
    const modelId = typeof message.model === "string" ? message.model : undefined;
    if (provider || modelId) {
      this.current.lastModel = {
        ...(provider ? { provider } : {}),
        ...(modelId ? { id: modelId } : {}),
        ...(this.current.lastModel?.thinkingLevel ? { thinkingLevel: this.current.lastModel.thinkingLevel } : {}),
        ...(this.current.lastModel?.contextWindow ? { contextWindow: this.current.lastModel.contextWindow } : {}),
      };
    }
    if (provider) {
      if (isAccountProvider(provider)) this.current.billingAccount = true;
      else this.current.billingApi = true;
    }
    const model = modelId ? (provider ? `${provider}/${modelId}` : modelId) : "unknown model";
    this.addUsage(message.usage, true, model, provider);
  }

  private addUsage(raw: unknown, assistantTurn: boolean, model: string | undefined, provider: string | undefined): void {
    const usage = usageOf(raw);
    if (!usage) return;
    const resolved = provider ?? this.current.lastModel?.provider;
    const account = isAccountProvider(resolved);
    if (account) this.current.billingAccount = true;
    else if (resolved) this.current.billingApi = true;
    addTotals(this.current.all, usage, assistantTurn);
    if (assistantTurn) this.current.usageTurnsAll += 1;
    if (model) addModelLine(this.current.byModelAll, model, usage);
    if (account || !resolved) {
      if (assistantTurn) this.current.tokenSeries.push(usage.total);
      return;
    }
    addTotals(this.current.api, usage, assistantTurn);
    if (assistantTurn) {
      this.current.usageTurnsApi += 1;
      this.current.costSeries.push(this.current.api.cost);
      this.current.tokenSeries.push(usage.total);
    }
    if (model) addModelLine(this.current.byModelApi, model, usage);
  }
}

function mergeChildSpend(
  state: TelemetryFoldState,
  child: { model?: string; spend?: TelemetryChildSpendFold },
): void {
  const model = child.model;
  if (model) {
    if (isAccountProvider(providerOfModel(model))) state.billingAccount = true;
    else state.billingApi = true;
  }
  const spend = child.spend;
  if (!spend) return;
  if (spend.billingAccount) state.billingAccount = true;
  if (spend.billingApi) state.billingApi = true;
  addTotals(state.all, spend.all, false);
  state.all.turns += spend.all.turns;
  addTotals(state.api, spend.api, false);
  state.api.turns += spend.api.turns;
  for (const line of spend.byModelAll) {
    const into = state.byModelAll[line.model] ?? { model: line.model, input: 0, output: 0, cost: 0 };
    into.input += line.input;
    into.output += line.output;
    into.cost += line.cost;
    state.byModelAll[line.model] = into;
  }
  for (const line of spend.byModelApi) {
    const into = state.byModelApi[line.model] ?? { model: line.model, input: 0, output: 0, cost: 0 };
    into.input += line.input;
    into.output += line.output;
    into.cost += line.cost;
    state.byModelApi[line.model] = into;
  }
}

function mergeChild(state: TelemetryFoldState, child: TelemetryChildSource): void {
  mergeChildSpend(state, {
    ...(child.model ? { model: child.model } : {}),
    ...(child.fold ? { spend: childSpendFoldOf(child.fold) } : {}),
  });
}

function billingOf(state: TelemetryFoldState, overlay?: TelemetryLiveOverlay): SessionBillingMode {
  let api = state.billingApi;
  let account = state.billingAccount;
  const provider = overlay?.model?.provider ?? state.lastModel?.provider;
  if (!api && !account && isAccountProvider(provider)) account = true;
  if (!api && !account && provider && !isAccountProvider(provider)) api = true;
  return api && account ? "mixed" : account ? "account" : api ? "api" : "none";
}

function wanted(include: readonly TelemetrySection[] | undefined, section: TelemetrySection): boolean {
  return include === undefined || include.includes(section);
}

function thinkingLevelOf(value: string | undefined): TelemetryModel["thinkingLevel"] | undefined {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

export function sessionTelemetryOf(
  fold: TelemetryFoldState,
  fence: { revision: string; environmentKey: string; authority: "live" | "durable" },
  options: {
    include?: readonly TelemetrySection[];
    scope?: TelemetryScope;
    turnId?: string;
    overlay?: TelemetryLiveOverlay;
    children?: readonly TelemetryChildSource[];
    childSpend?: readonly TelemetryChildSpendSource[];
    coverage?: TelemetrySpendCoverage;
  } = {},
): SessionTelemetry {
  const state = cloneState(fold);
  for (const child of options.children ?? []) mergeChild(state, child);
  for (const child of options.childSpend ?? []) mergeChildSpend(state, child);
  const include = options.include;
  const overlay = options.overlay;
  const result: SessionTelemetry = {
    revision: fence.revision,
    environmentKey: fence.environmentKey,
    authority: fence.authority,
    scope: options.scope ?? "session",
    ...(options.turnId ? { turnId: options.turnId } : {}),
  };

  if (wanted(include, "context") && overlay?.context) result.context = overlay.context;

  if (wanted(include, "spend")) {
    const billing = billingOf(state, overlay);
    const spend: TelemetrySpend = {
      billing,
      ...(options.coverage ? { coverage: { ...options.coverage } } : {}),
    };
    if (billing === "api" || billing === "mixed") {
      if (state.api.turns > 0 || state.api.cost > 0 || state.api.total > 0) {
        spend.api = {
          totals: cloneTotals(state.api),
          byModel: Object.values(state.byModelApi).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model)),
          series: downsampleSeries(state.costSeries),
        };
      }
    }
    if (overlay?.account && (billing === "account" || billing === "mixed")) spend.account = overlay.account;
    result.spend = spend;
  }

  if (wanted(include, "model")) {
    const live = overlay?.model;
    const stored = state.lastModel;
    const thinking = thinkingLevelOf(live?.thinkingLevel ?? stored?.thinkingLevel);
    const provider = live?.provider ?? stored?.provider;
    const id = live?.id ?? stored?.id;
    const contextWindow = live?.contextWindow ?? stored?.contextWindow;
    const model: TelemetryModel = { tokenSeries: downsampleSeries(state.tokenSeries) };
    if (provider !== undefined) model.provider = provider;
    if (id !== undefined) model.id = id;
    if (live?.profileId !== undefined) model.profileId = live.profileId;
    if (thinking !== undefined) model.thinkingLevel = thinking;
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    result.model = model;
  }

  if (wanted(include, "work")) {
    const tools = ranked(state.toolCounts, TELEMETRY_TOOL_HISTOGRAM_TOP);
    const failed = ranked(state.toolFailed, TELEMETRY_TOOL_HISTOGRAM_TOP);
    const start = state.firstTimestamp;
    const end = state.lastTimestamp;
    result.work = {
      turns: state.assistantTurns,
      durationMs: start !== null && end !== null && end >= start ? end - start : 0,
      tools: {
        total: Object.values(state.toolCounts).reduce((sum, count) => sum + count, 0),
        ranked: tools.ranked,
        other: tools.other,
        failed: failed.ranked,
      },
    };
  }

  if (wanted(include, "history")) {
    result.history = {
      prompts: state.prompts,
      records: state.records,
      compactions: state.compactions,
      branches: state.forks + state.branchSummaries,
    };
  }

  return result;
}

/**
 * Entries of one user-anchored turn on the rendered branch: the prompt
 * `turnId` through the record before the next user message toward the leaf.
 */
export function turnEntryIndices(
  entries: readonly unknown[],
  leafId: string | null,
  turnId: string,
): number[] | undefined {
  const byId = new Map<string, number>();
  entries.forEach((entry, index) => {
    const id = entryId(entry);
    if (id !== undefined) byId.set(id, index);
  });
  const branch: number[] = [];
  const seen = new Set<string>();
  let id: string | null = leafId;
  while (typeof id === "string") {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const index = byId.get(id);
    if (index === undefined) return undefined;
    branch.push(index);
    id = parentIdOf(entries[index]!);
  }
  branch.reverse();
  const start = branch.findIndex((index) => entryId(entries[index]!) === turnId);
  if (start < 0) return undefined;
  const isUser = (index: number): boolean => {
    const value = record(entries[index]);
    return value.type === "message" && record(value.message).role === "user";
  };
  let end = branch.length;
  for (let cursor = start + 1; cursor < branch.length; cursor++) {
    if (isUser(branch[cursor]!)) {
      end = cursor;
      break;
    }
  }
  return branch.slice(start, end);
}
