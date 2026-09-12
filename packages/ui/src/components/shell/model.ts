/**
 * Pure view-model helpers for the app shell. No React, no DOM.
 * Tested in test/shell/model.test.ts.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import type { AgentRun, ProjectInfo, ProjectTrust, SessionSummary } from "@lasercode/protocol";
import { mergeSessions, sessionAttention, sessionTitle, sortSessions } from "../../runtime/threadList.js";
import { textOf, type Block, type SessionView } from "../../store.js";
import { shortCwd, summariseArgs } from "../../format.js";
import { aggregateStatus, statusRank, type Status } from "../status/status.js";

export type WorkerInfo = { status: string; message?: string };
export type Views = Readonly<Record<string, SessionView | undefined>>;
export type Workers = Readonly<Record<string, WorkerInfo | undefined>>;
export type Projects = Readonly<Record<string, ProjectInfo | undefined>>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  cwd: string;
  /** Last path segment. */
  name: string;
  /** Aggregate of every session in the project; a crashed worker counts as an error. */
  status: Status;
  sessionCount: number;
  /** Sessions in `waiting_for_input`. */
  needYou: number;
  worker: WorkerInfo | undefined;
  /** Pi project trust, from the host. `undefined` until the project list lands. */
  trust: ProjectTrust | undefined;
  /** True when a person added this directory rather than it being discovered. */
  pinned: boolean;
}

/** Catalog ∪ open views, restricted to one project, attention-sorted. */
export function sessionsForProject(cwd: string | undefined, sessions: readonly SessionSummary[], open: Views): SessionSummary[] {
  if (!cwd) return [];
  const merged = mergeSessions(sessions, open).filter((s) => s.cwd === cwd);
  return sortSessions(merged, open);
}

export function needYouCount(sessions: readonly SessionSummary[], open: Views): number {
  let n = 0;
  for (const s of sessions) if (sessionAttention(s, open[s.path]) === "waiting_for_input") n++;
  return n;
}

export function projectSummaries(
  projects: readonly string[],
  sessions: readonly SessionSummary[],
  open: Views,
  workers: Workers,
  info: Projects = {},
): ProjectSummary[] {
  const all = mergeSessions(sessions, open);
  return projects.map((cwd) => {
    const mine = all.filter((s) => s.cwd === cwd);
    const worker = workers[cwd];
    const project = info[cwd];
    const statuses = mine.map((s) => sessionAttention(s, open[s.path]));
    if (worker?.status === "crashed") statuses.push("error");
    return {
      cwd,
      name: shortCwd(cwd),
      status: aggregateStatus(statuses),
      sessionCount: mine.length,
      needYou: needYouCount(mine, open),
      worker,
      trust: project?.trust,
      pinned: project?.pinned ?? false,
    };
  });
}

/** The words next to a project's trust state; `undefined` when there is nothing to say. */
export function trustLabel(trust: ProjectTrust | undefined): { label: string; tone: "attention" | "muted" } | undefined {
  switch (trust) {
    case "declined":
      return { label: "Project files not loaded", tone: "muted" };
    case "unknown":
      return { label: "Needs approval", tone: "attention" };
    default:
      // `trusted` and `not_required` are the normal case: say nothing.
      return undefined;
  }
}

/**
 * Directories seen in the catalog, most recently modified first. Used by the
 * add-project dialog so a path never has to be typed twice.
 */
export function recentCwds(sessions: readonly SessionSummary[], limit = 8): string[] {
  const latest = new Map<string, number>();
  for (const s of sessions) {
    const t = Date.parse(s.modifiedAt);
    const prev = latest.get(s.cwd) ?? -Infinity;
    if (!(t < prev)) latest.set(s.cwd, Number.isNaN(t) ? prev : t);
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cwd]) => cwd);
}

/** Absolute POSIX or Windows path. */
export function isAbsolutePath(value: string): boolean {
  const v = value.trim();
  return /^\//.test(v) || /^[A-Za-z]:[\\/]/.test(v) || /^~\//.test(v);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const lastTool = (blocks: readonly Block[]): Extract<Block, { kind: "tool" }> | undefined => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === "tool") return b;
  }
  return undefined;
};

const firstUserText = (blocks: readonly Block[]): string | undefined => {
  for (const b of blocks) if (b.kind === "user") return b.text;
  return undefined;
};

export interface SessionSubtitle {
  text: string;
  /** Typed (mono) when it is a tool invocation. */
  mono: boolean;
  tone: "attention" | "default" | "muted";
}

/** Row subtitle: waiting for you > last tool > first message > placeholder. */
export function sessionSubtitle(summary: SessionSummary, view: SessionView | undefined): SessionSubtitle {
  if (view && view.dialogs.length > 0) return { text: "Waiting for you", mono: false, tone: "attention" };
  const tool = view ? lastTool(view.blocks) : undefined;
  if (tool) {
    const args = summariseArgs(tool.name, tool.args);
    return { text: args ? `${tool.name}  ${args}` : tool.name, mono: true, tone: "default" };
  }
  const first = (view && (view.history?.userOffset ?? 0) === 0 ? firstUserText(view.blocks) : undefined) ?? summary.firstMessage?.trim();
  if (first) return { text: first.replace(/\s+/g, " "), mono: false, tone: "default" };
  return { text: "No messages yet", mono: false, tone: "muted" };
}

/**
 * True when nothing has named this session yet, so the row is showing the
 * "New session" placeholder rather than a title anybody chose.
 *
 * It used to mean "showing the id prefix", and the rows styled it as typed
 * mono for that reason. The fallback is now the first line the person typed,
 * which is a sentence and is set in the text face like any other title; only
 * the placeholder is still dimmed.
 */
export function isUntitled(summary: SessionSummary, view: SessionView | undefined): boolean {
  return !(summary.name ?? view?.title ?? summary.firstMessage?.trim() ?? (view && (view.history?.userOffset ?? 0) === 0 ? firstUserText(view.blocks) : undefined));
}

/** One vocabulary for the dot and the words next to it (DESIGN.md "Status language"). */
export function sessionStatus(view: SessionView | undefined, summary?: SessionSummary): Status {
  if (!view) return summary?.attention ?? "idle";
  if (view.dialogs.length > 0) return "waiting_for_input";
  if (view.running || view.state.isCompacting) return "working";
  return summary?.attention ?? "idle";
}

export function sessionStateLabel(view: SessionView | undefined, worker?: WorkerInfo | undefined): string {
  if (worker?.status === "crashed") return "Worker crashed";
  if (!view) return "";
  if (view.dialogs.length > 0) return "Waiting for you";
  if (view.state.isCompacting) return "Compacting context";
  if (view.running) return "Working";
  if (worker?.status === "starting") return "Starting worker";
  return "Idle";
}

export interface WorkerChip {
  label: string;
  tone: "attention" | "danger" | "muted";
  /** What went wrong, in full, for the tooltip. */
  detail?: string;
  /** True when `pi/worker/restart` would do something: offer a retry. */
  canRetry: boolean;
}

/** Chip for the top bar; `undefined` when the worker is ready (nothing to say). */
export function workerChip(worker: WorkerInfo | undefined): WorkerChip | undefined {
  if (!worker || worker.status === "ready") return undefined;
  const detail = worker.message ? { detail: worker.message } : {};
  switch (worker.status) {
    case "starting":
      return { label: "Starting the agent", tone: "attention", canRetry: false, ...detail };
    case "crashed":
      return { label: "Worker crashed", tone: "danger", canRetry: true, ...detail };
    case "retired":
      return { label: "Worker asleep", tone: "muted", canRetry: true, ...detail };
    default:
      return { label: `Worker ${worker.status}`, tone: "muted", canRetry: false, ...detail };
  }
}

// ---------------------------------------------------------------------------
// Inbox (M2-T2)
// ---------------------------------------------------------------------------

export interface InboxRow {
  path: string;
  cwd: string;
  /** Directory name, so a row read out of project context still makes sense. */
  project: string;
  title: string;
  status: Status;
  sub: SessionSubtitle;
  modifiedAt: string;
}

/**
 * Sessions that want a person, across every project, most urgent first.
 *
 * Derived here rather than through `pi/session/inbox`: the client already holds
 * every summary plus the live views, and a round trip per attention change
 * would be a catalog scan per turn. The host query exists for clients that hold
 * no catalog (the CLI, and anything on the far side of the relay).
 */
export function inboxRows(sessions: readonly SessionSummary[], open: Views, limit = 20): InboxRow[] {
  return mergeSessions(sessions, open)
    .map((summary) => {
      const view = open[summary.path];
      return {
        path: summary.path,
        cwd: summary.cwd,
        project: shortCwd(summary.cwd),
        title: sessionTitle(summary, view),
        status: sessionStatus(view, summary),
        sub: sessionSubtitle(summary, view),
        modifiedAt: summary.modifiedAt,
      };
    })
    .filter((row) => row.status !== "idle")
    .sort((a, b) => {
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
      return a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0;
    })
    .slice(0, limit);
}

/** Browser tab title: `(2) Session name · laser`. */
export function documentTitle(sessionTitle: string | undefined, needYou: number): string {
  const prefix = needYou > 0 ? `(${needYou}) ` : "";
  return sessionTitle ? `${prefix}${sessionTitle} · ${PRODUCT_DISPLAY_NAME}` : `${prefix}${PRODUCT_DISPLAY_NAME}`;
}

// ---------------------------------------------------------------------------
// Usage and history from persisted entries (Pi session-format.md)
// ---------------------------------------------------------------------------

interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface RawEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    usage?: RawUsage;
    stopReason?: string;
    provider?: string;
    model?: string;
  };
  usage?: RawUsage;
  summary?: string;
  label?: string;
  targetId?: string;
  name?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Assistant turns that reported usage. */
  turns: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type SessionBillingMode = "api" | "account" | "mixed" | "none";

export function isAccountProvider(provider: string | undefined): boolean {
  return provider === "openai-codex" || /^openai-codex-\d+$/.test(provider ?? "");
}

/**
 * One child agent's contribution to this session's billing view.
 *
 * `usage` is absent, and that is the honest answer: the harness measures a
 * run's identity, status and model, never its tokens (D-140). What the model
 * *is* still decides which billing view the session is in — an account-billed
 * child makes the session "mixed" whatever the parent used — so the mode is
 * derived and the numbers are not invented.
 */
export interface BackgroundUsageSource {
  /** Model reference (`provider/model`) when the run recorded one. */
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number; turns?: number };
}

const providerOfModel = (model: string | undefined): string | undefined => model?.split("/", 1)[0];
const isAccountModel = (model: string | undefined): boolean => isAccountProvider(providerOfModel(model));

/** Every child agent that executed in this session's tree is one source. */
export function backgroundUsageSources(runs: readonly AgentRun[]): BackgroundUsageSource[] {
  return runs.map((run) => (run.model ? { model: `${run.model.provider}/${run.model.id}` } : {}));
}

/** Billing views represented by the main agent and every child agent. */
export function sessionBillingMode(
  entries: readonly unknown[],
  background: readonly BackgroundUsageSource[] = [],
): SessionBillingMode {
  let api = false;
  let account = false;
  for (const raw of entries) {
    const entry = raw as RawEntry;
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (isAccountProvider(entry.message.provider)) account = true;
    else api = true;
  }
  for (const source of background) {
    if (isAccountModel(source.model)) account = true;
    else api = true;
  }
  return api && account ? "mixed" : account ? "account" : api ? "api" : "none";
}

function includeUsage(entry: RawEntry, billing: "all" | "api"): boolean {
  if (billing === "all") return true;
  const provider = entry.type === "message" ? entry.message?.provider : entry.provider;
  return !isAccountProvider(provider);
}

/** Sum of every `usage` block on the file (assistant messages, compactions, branch summaries). */
export function usageFromEntries(
  entries: readonly unknown[],
  billing: "all" | "api" = "all",
  background: readonly BackgroundUsageSource[] = [],
): UsageTotals | undefined {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, turns: 0 };
  let seen = false;
  for (const raw of entries) {
    const e = raw as RawEntry;
    const usage = e.type === "message" ? (e.message?.role === "assistant" ? e.message.usage : undefined) : e.usage;
    if (!usage || !includeUsage(e, billing)) continue;
    seen = true;
    totals.input += num(usage.input);
    totals.output += num(usage.output);
    totals.cacheRead += num(usage.cacheRead);
    totals.cacheWrite += num(usage.cacheWrite);
    totals.total += num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
    totals.cost += num(usage.cost?.total);
    if (e.type === "message") totals.turns++;
  }
  for (const source of background) {
    if (!source.usage || (billing === "api" && isAccountModel(source.model))) continue;
    const usage = source.usage;
    seen = true;
    totals.input += num(usage.input);
    totals.output += num(usage.output);
    totals.cacheRead += num(usage.cacheRead);
    totals.cacheWrite += num(usage.cacheWrite);
    totals.total += num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
    totals.cost += num(usage.costUsd);
    totals.turns += num(usage.turns);
  }
  return seen ? totals : undefined;
}

export interface ModelUsageLine {
  model: string;
  input: number;
  output: number;
  cost: number;
}

/**
 * Spend per model, most expensive first, from the assistant messages that
 * carry a `model` (Pi stamps provider and model on each). Compactions and
 * branch summaries have no model and fold into the session total only.
 */
export function usageByModel(
  entries: readonly unknown[],
  billing: "all" | "api" = "all",
  background: readonly BackgroundUsageSource[] = [],
): ModelUsageLine[] {
  const byModel = new Map<string, ModelUsageLine>();
  for (const raw of entries) {
    const e = raw as RawEntry;
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage || !includeUsage(e, billing)) continue;
    const model = e.message.model ? (e.message.provider ? `${e.message.provider}/${e.message.model}` : e.message.model) : "unknown model";
    const line = byModel.get(model) ?? { model, input: 0, output: 0, cost: 0 };
    line.input += num(e.message.usage.input);
    line.output += num(e.message.usage.output);
    line.cost += num(e.message.usage.cost?.total);
    byModel.set(model, line);
  }
  for (const source of background) {
    if (!source.usage || (billing === "api" && isAccountModel(source.model))) continue;
    const model = source.model ?? "unknown subagent model";
    const line = byModel.get(model) ?? { model, input: 0, output: 0, cost: 0 };
    line.input += num(source.usage.input);
    line.output += num(source.usage.output);
    line.cost += num(source.usage.costUsd);
    byModel.set(model, line);
  }
  return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

/** Cumulative cost after each assistant turn, in file order. */
export function spendSeries(
  entries: readonly unknown[],
  billing: "all" | "api" = "all",
  background: readonly BackgroundUsageSource[] = [],
): number[] {
  const series: number[] = [];
  let total = 0;
  for (const raw of entries) {
    const e = raw as RawEntry;
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage || !includeUsage(e, billing)) continue;
    total += num(e.message.usage.cost?.total);
    series.push(total);
  }
  for (const source of background) {
    if (!source.usage || (billing === "api" && isAccountModel(source.model))) continue;
    total += num(source.usage.costUsd);
    series.push(total);
  }
  return series;
}

export type HistoryKind =
  | "user"
  | "assistant"
  | "tool"
  | "compaction"
  | "branch"
  | "custom"
  | "name"
  | "model"
  | "thinking";

export interface HistoryRow {
  id: string;
  parentId: string | null;
  kind: HistoryKind;
  /** Nesting depth: number of ancestors that fork. */
  depth: number;
  /** True when this entry is the first of a side branch (its parent has several children). */
  branchStart: boolean;
  text: string;
  at: string | undefined;
  label: string | undefined;
  /** Number of tool calls folded into this assistant row. */
  tools: number;
  canFork: boolean;
  canJump: boolean;
}

const entryTime = (value: unknown): string | undefined => {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return undefined;
};

const assistantText = (content: unknown): { text: string; tools: number; thinking: boolean } => {
  if (!Array.isArray(content)) return { text: textOf(content), tools: 0, thinking: false };
  let tools = 0;
  let thinking = false;
  for (const part of content as Array<{ type?: string }>) {
    if (part?.type === "toolCall") tools++;
    if (part?.type === "thinking") thinking = true;
  }
  return { text: textOf(content), tools, thinking };
};

/**
 * Flatten the entry tree into rows in file order (which is parent-before-child
 * in Pi's format). Labels are attached to their target rows instead of
 * rendering as rows; tool results fold into the assistant row that called them.
 */
export function historyRows(entries: readonly unknown[]): HistoryRow[] {
  const raw = entries as RawEntry[];
  const children = new Map<string | null, number>();
  const byId = new Map<string, RawEntry>();
  const labels = new Map<string, string>();
  for (const e of raw) {
    if (!e.id) continue;
    byId.set(e.id, e);
    children.set(e.parentId ?? null, (children.get(e.parentId ?? null) ?? 0) + 1);
    if (e.type === "label" && e.targetId) {
      if (e.label) labels.set(e.targetId, e.label);
      else labels.delete(e.targetId);
    }
  }
  // A label entry itself is a tree node, so it must not count as a fork point.
  for (const e of raw) if (e.type === "label") children.set(e.parentId ?? null, (children.get(e.parentId ?? null) ?? 1) - 1);

  const depthOf = (e: RawEntry): number => {
    let d = 0;
    let p = e.parentId ?? null;
    while (p) {
      if ((children.get(p) ?? 0) > 1) d++;
      p = byId.get(p)?.parentId ?? null;
    }
    return d;
  };

  const rows: HistoryRow[] = [];
  let lastAssistant: HistoryRow | undefined;
  for (const e of raw) {
    if (!e.id) continue;
    const base = {
      id: e.id,
      parentId: e.parentId ?? null,
      depth: depthOf(e),
      branchStart: (children.get(e.parentId ?? null) ?? 0) > 1,
      at: entryTime(e.timestamp),
      label: labels.get(e.id),
      tools: 0,
    };
    let row: HistoryRow | undefined;
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "user") {
        row = { ...base, kind: "user", text: textOf(m.content), canFork: true, canJump: true };
      } else if (m.role === "assistant") {
        const { text, tools, thinking } = assistantText(m.content);
        row = {
          ...base,
          kind: "assistant",
          text: text || (tools ? "" : thinking ? "Reasoning only" : ""),
          tools,
          canFork: true,
          canJump: true,
        };
        lastAssistant = row;
      } else if (m.role === "toolResult") {
        // Folded into the calling assistant row (a label on the result still surfaces).
        if (lastAssistant && base.label) lastAssistant.label = base.label;
        continue;
      } else if (m.role === "custom" || m.role === "bashExecution") {
        row = { ...base, kind: "custom", text: textOf(m.content), canFork: true, canJump: true };
      } else {
        continue;
      }
    } else if (e.type === "compaction") {
      row = { ...base, kind: "compaction", text: e.summary ?? "Context compacted", canFork: false, canJump: true };
    } else if (e.type === "branch_summary") {
      row = { ...base, kind: "branch", text: e.summary ?? "Branch summary", canFork: false, canJump: true };
    } else if (e.type === "custom_message") {
      if (e.display === false) continue;
      row = { ...base, kind: "custom", text: textOf(e.content), canFork: false, canJump: true };
    } else if (e.type === "session_info") {
      row = { ...base, kind: "name", text: e.name ?? "", canFork: false, canJump: false };
    } else if (e.type === "model_change") {
      row = { ...base, kind: "model", text: [e.provider, e.modelId].filter(Boolean).join("/"), canFork: false, canJump: false };
    } else if (e.type === "thinking_level_change") {
      row = { ...base, kind: "thinking", text: e.thinkingLevel ?? "", canFork: false, canJump: false };
    }
    if (row) rows.push(row);
  }
  return rows;
}

/** Entry id of the most recent user prompt; what "fork from last prompt" forks at. */
export function lastPromptEntryId(entries: readonly unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as RawEntry;
    if (e.type === "message" && e.message?.role === "user" && e.id) return e.id;
  }
  return undefined;
}

export const HISTORY_KIND_LABEL: Record<HistoryKind, string> = {
  user: "You",
  assistant: "Agent",
  tool: "Tool",
  compaction: "Compaction",
  branch: "Branch summary",
  custom: "Extension",
  name: "Renamed",
  model: "Model",
  thinking: "Thinking",
};
