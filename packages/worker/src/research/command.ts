/**
 * A research run as a visible, bounded, stoppable Command.
 *
 * `docs/research-phase.md` asks for the budget to be **visible** — "the budget
 * is visible in the fleet row and the Research header" — and for progress to
 * be the question tree's states and the budget spent, with "no percentages, no
 * invented ETA". This is that surface: a title, a phase, the counted spend,
 * the elapsed time and `stop()`.
 *
 * It runs nothing. The loop is the agent's own turn (D-351: the agent runs the
 * retrieval loop itself); this object only lets the host publish what that run
 * is spending beside the agents, and lets a person end it. Stopping sets the
 * ledger's stop, so the next tool call is refused with the sentence that says
 * the research was stopped — the run ends on a refusal it can report, not on a
 * killed process.
 */
import { RESEARCH_BUDGET_DEFAULTS, type ResearchBudget } from "@lasercode/protocol";
import { ResearchLedger, researchBudgetLine, type ResearchSpend } from "./budget.js";

export const RESEARCH_PHASES = ["framing", "retrieving", "reading", "recording", "resolving", "done", "stopped"] as const;
export type ResearchPhase = (typeof RESEARCH_PHASES)[number];

export interface ResearchCommandProgress {
  phase: ResearchPhase;
  spend: ResearchSpend;
  /** The one line the fleet row shows. */
  line: string;
  /** Questions still open, and how many there are in all. */
  openQuestions: number;
  totalQuestions: number;
}

export interface ResearchCommandOptions {
  /** The research artifact this run writes to, when one is named yet. */
  researchRef?: string;
  /**
   * The root question, when this run was opened from one.
   *
   * Absent for a loop that starts before any artifact is named — the model
   * searching before it writes the question tree — and absent from the fleet
   * row either way: a row says what a run is *doing* and what it is spending,
   * never what it is looking for.
   */
  question?: string;
  ledger?: ResearchLedger;
  budget?: ResearchBudget;
  now?: () => number;
  onProgress?: (progress: ResearchCommandProgress) => void;
}

let counter = 0;

/** One research run, as the fleet sees it. */
export class ResearchCommand {
  readonly id: string;
  readonly title: string;
  readonly ledger: ResearchLedger;
  private phaseValue: ResearchPhase = "framing";
  private open = 0;
  private total = 0;

  constructor(private readonly options: ResearchCommandOptions) {
    counter += 1;
    this.id = `res_${String(counter).padStart(4, "0")}`;
    this.title = options.question ? `Research · ${options.question.slice(0, 80)}` : "Research";
    this.ledger =
      options.ledger ??
      new ResearchLedger({ budget: options.budget ?? RESEARCH_BUDGET_DEFAULTS, ...(options.now !== undefined ? { now: options.now } : {}) });
  }

  get phase(): ResearchPhase {
    return this.phaseValue;
  }

  get researchRef(): string | undefined {
    return this.options.researchRef;
  }

  /** Move the row on. `done` and `stopped` are terminal. */
  advance(phase: ResearchPhase): void {
    if (this.phaseValue === "stopped" && phase !== "stopped") return;
    this.phaseValue = phase;
    this.publish();
  }

  /** The question tree's states: the only progress this run reports. */
  questions(open: number, total: number): void {
    this.open = open;
    this.total = total;
    this.publish();
  }

  progress(): ResearchCommandProgress {
    const spend = this.ledger.spent();
    return {
      phase: this.phaseValue,
      spend,
      line: researchBudgetLine(spend, this.ledger.budget),
      openQuestions: this.open,
      totalQuestions: this.total,
    };
  }

  /**
   * A person's stop. The next tool call the run makes is refused with the
   * sentence that tells the model to report what it has, so a stopped research
   * still ends with an answer rather than with silence.
   */
  stop(reason = "this research was stopped by the person"): void {
    this.ledger.stop(reason);
    this.phaseValue = "stopped";
    this.publish();
  }

  /** The sentence the run reports at the end (loop step 7). */
  report(): string {
    const spent = this.ledger.line();
    const remaining = this.open === 0 ? "every question is resolved" : `${String(this.open)} of ${String(this.total)} questions are still open`;
    const stopped = this.ledger.stopped();
    return stopped ? `Stopped: ${stopped}. ${remaining}. Spent: ${spent}.` : `${capitalise(remaining)}. Spent: ${spent}.`;
  }

  private publish(): void {
    this.options.onProgress?.(this.progress());
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * What each phase is called in a row a person reads.
 *
 * Present tense, no percentage, no ETA, and nothing about *what* is being
 * searched or read: the phase plus the counted spend is the whole line
 * (`docs/research-phase.md`, "What a person sees": "Progress is the question
 * tree's states and the budget spent; no percentages, no invented ETA").
 */
export const RESEARCH_PHASE_LINES: Record<ResearchPhase, string> = {
  framing: "Framing the questions",
  retrieving: "Searching sources",
  reading: "Reading a source",
  recording: "Recording a finding",
  resolving: "Resolving a question",
  done: "Finished",
  stopped: "Stopped",
};

/**
 * The one line the fleet row shows: the phase, then the budget.
 *
 * Content-free by construction: it is built from an enum and four counted
 * numbers, so a question's text or a source's address cannot reach it. Cut to
 * `RESEARCH_ROW_ACTIVITY_MAX` all the same, so the row's length is a
 * guarantee and not an inference about how long four numbers can be.
 */
export const RESEARCH_ROW_ACTIVITY_MAX = 200;

export function researchActivityLine(progress: ResearchCommandProgress, stopping = false): string {
  // `stopping` is a stop that was accepted while a call was still in flight.
  // The row is still running, so this is the sentence a person reads instead
  // of the step that is no longer going to finish — and it never says the run
  // has stopped, because it has not.
  const phase = stopping ? "Stopping — keeping what this research found" : RESEARCH_PHASE_LINES[progress.phase];
  return `${phase} · ${progress.line}`.slice(0, RESEARCH_ROW_ACTIVITY_MAX);
}
