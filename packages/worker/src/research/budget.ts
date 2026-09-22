/**
 * The budget of one research run, and the two loop rules it enforces
 * (`docs/research-phase.md`, "The loop the agent runs", step 2 and step 7;
 * D-351.g).
 *
 * A budget is four numbers — searches, reads, bytes and wall clock — and it
 * is **visible**: `line()` is what the fleet row and the Research header both
 * show, in units a person can check, never a percentage of an unknown total.
 *
 * Two rules live here rather than in advice to the model, because advice is
 * what a long run forgets:
 *
 * - **Never re-run an identical query.** The ledger remembers every
 *   `(adapter, query, window)` and refuses the repeat with the call to make
 *   instead.
 * - **One fetch per source per run.** A second read of a source already read
 *   is served from the cache and costs no read.
 */
import { RESEARCH_BUDGET_DEFAULTS, type ResearchBudget } from "@lasercode/protocol";

export interface ResearchSpend {
  searches: number;
  reads: number;
  bytes: number;
  elapsedMs: number;
}

/** A refusal from the ledger, in the tool contract's shape. Nothing is spent. */
export class ResearchBudgetRefused extends Error {
  readonly code: string;
  readonly next: string;
  readonly committed = false;
  /** True when the run is over, not merely this call. */
  readonly exhausted: boolean;
  constructor(code: string, message: string, next: string, exhausted = false) {
    super(message);
    this.name = "ResearchBudgetRefused";
    this.code = code;
    this.next = next;
    this.exhausted = exhausted;
  }
}

/** Bytes in the units a person reads. */
export function formatBytes(bytes: number): string {
  return bytesLine(bytes);
}

/** Elapsed time in the units a person reads. */
export function formatElapsed(ms: number): string {
  return elapsedLine(ms);
}

function bytesLine(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function elapsedLine(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

/** The one line a fleet row and the Research header show. Counted, never estimated. */
export function researchBudgetLine(spend: ResearchSpend, budget: ResearchBudget): string {
  return [
    `${String(spend.searches)}/${String(budget.maxSearches)} searches`,
    `${String(spend.reads)}/${String(budget.maxReads)} reads`,
    `${bytesLine(spend.bytes)} of ${bytesLine(budget.maxBytes)}`,
    elapsedLine(spend.elapsedMs),
  ].join(" · ");
}

/** A query, as the ledger compares two of them: case and spacing are not a difference. */
export function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ResearchLedgerOptions {
  budget?: Partial<ResearchBudget>;
  now?: () => number;
}

/** What one run has spent, and what it may still do. */
export class ResearchLedger {
  readonly budget: ResearchBudget;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly queries = new Map<string, number>();
  private readonly fetched = new Set<string>();
  private searches = 0;
  private reads = 0;
  private bytes = 0;
  private stoppedReason?: string;

  constructor(options: ResearchLedgerOptions = {}) {
    this.budget = { ...RESEARCH_BUDGET_DEFAULTS, ...options.budget };
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  spent(): ResearchSpend {
    return { searches: this.searches, reads: this.reads, bytes: this.bytes, elapsedMs: Math.max(0, this.now() - this.startedAt) };
  }

  remaining(): ResearchSpend {
    const spent = this.spent();
    return {
      searches: Math.max(0, this.budget.maxSearches - spent.searches),
      reads: Math.max(0, this.budget.maxReads - spent.reads),
      bytes: Math.max(0, this.budget.maxBytes - spent.bytes),
      elapsedMs: Math.max(0, this.budget.maxWallClockMs - spent.elapsedMs),
    };
  }

  line(): string {
    return researchBudgetLine(this.spent(), this.budget);
  }

  /** Why the run stopped, when it did. Undefined while it may still spend. */
  stopped(): string | undefined {
    if (this.stoppedReason) return this.stoppedReason;
    const spent = this.spent();
    if (spent.elapsedMs >= this.budget.maxWallClockMs) return "the time this research was given is spent";
    if (spent.bytes >= this.budget.maxBytes) return "this research has read as many bytes as it was given";
    if (spent.searches >= this.budget.maxSearches && spent.reads >= this.budget.maxReads) return "this research has spent its searches and its reads";
    return undefined;
  }

  /** Stop the run from the outside: a person's stop, or a cancelled command. */
  stop(reason = "this research was stopped"): void {
    this.stoppedReason = reason;
  }

  private wallClock(): void {
    const spent = this.spent();
    if (spent.elapsedMs >= this.budget.maxWallClockMs) {
      throw new ResearchBudgetRefused(
        "budget_spent",
        `This research has been running for ${elapsedLine(spent.elapsedMs)}, which is the time it was given (${elapsedLine(this.budget.maxWallClockMs)}). ${this.report()}`,
        "resolve the questions you can with what you already found, mark the rest unanswerable or hand them to the person, and say what the budget stopped",
        true,
      );
    }
    if (this.stoppedReason !== undefined) {
      throw new ResearchBudgetRefused("research_stopped", `${capitalise(this.stoppedReason)}. ${this.report()}`, "resolve the questions you can with what you already found and report what remains", true);
    }
  }

  /**
   * Charge one search. Refuses an identical query, and the search that would
   * go past the budget.
   *
   * `window` is the date bound of the search, so "react 19 forms, last month"
   * and "react 19 forms, any time" are two different queries and the second is
   * not a repeat.
   */
  chargeSearch(adapter: string, query: string, window?: string): void {
    this.wallClock();
    const key = `${adapter}\u0000${normaliseQuery(query)}\u0000${window ?? ""}`;
    const seen = this.queries.get(key);
    if (seen !== undefined) {
      throw new ResearchBudgetRefused(
        "identical_query",
        `This run has already asked ${adapter} exactly that. Asking again returns the same hits and spends the budget twice.`,
        "search with different terms, bound it by date, try another adapter, or read one of the sources you already found with read_source",
      );
    }
    if (this.searches >= this.budget.maxSearches) {
      throw new ResearchBudgetRefused(
        "budget_spent",
        `This research has used all ${String(this.budget.maxSearches)} of its searches. ${this.report()}`,
        "read the best of what you already found with read_source, then resolve the questions and report what the budget stopped",
        true,
      );
    }
    this.queries.set(key, this.now());
    this.searches += 1;
  }

  /**
   * Charge one read. A source this run already fetched costs nothing and is
   * answered from the cache — one fetch per source per run.
   */
  chargeRead(sourceId: string): { cached: boolean } {
    this.wallClock();
    if (this.fetched.has(sourceId)) return { cached: true };
    if (this.reads >= this.budget.maxReads) {
      throw new ResearchBudgetRefused(
        "budget_spent",
        `This research has used all ${String(this.budget.maxReads)} of its reads. ${this.report()}`,
        "record the findings from what you have read, resolve what you can, and report what the budget stopped",
        true,
      );
    }
    this.reads += 1;
    this.fetched.add(sourceId);
    return { cached: false };
  }

  /** Charge the bytes a fetch really cost. Over the ceiling is the end of the run. */
  chargeBytes(bytes: number): void {
    this.bytes += Math.max(0, bytes);
    if (this.bytes >= this.budget.maxBytes) {
      throw new ResearchBudgetRefused(
        "budget_spent",
        `This research has read ${bytesLine(this.bytes)}, which is as much as it was given. ${this.report()}`,
        "record what the pages you already read say, resolve the questions you can, and report what the budget stopped",
        true,
      );
    }
  }

  /** Whether this run has already fetched that source. */
  hasFetched(sourceId: string): boolean {
    return this.fetched.has(sourceId);
  }

  /** The sentence that goes in every budget refusal and in the final report. */
  report(): string {
    return `Spent: ${this.line()}.`;
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
