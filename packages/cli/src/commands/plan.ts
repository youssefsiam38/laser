/**
 * `piorbit plan <run>` — the intended shape of a multi-step run.
 *
 * A plan is either **declared** (pi-subagents persisted a `workflowGraph` for a
 * chain or parallel launch) or **inferred** (a scripted workflow persists no
 * structure at all, so the host rebuilt it from the preflight lanes and the
 * trace). This command says which, every time, in one word — R3 is not a UI
 * rule, it is a truthfulness rule, and a terminal that quietly presented a
 * guess as a fact would be worse than the app doing it, because people pipe
 * terminal output into other things.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import type { PlanPanel, PlanStep, SessionSummary } from "@lasercode/protocol";
import type { Command } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { clip, plural } from "../format.js";
import { table } from "../output.js";

import { describeRpcError } from "../rpc.js";
import { connect } from "./host.js";
import { formatElapsed, readFleet, sessionsInScope, usageCells } from "./runs.js";

const STATE_WORD: Record<PlanStep["state"], string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  blocked: "blocked",
};

interface Phase {
  title: string;
  steps: PlanStep[];
}

/** Phase-ordered, exactly as the panel arrived — the order is part of the plan. */
export function groupPhases(steps: readonly PlanStep[]): Phase[] {
  const phases: Phase[] = [];
  for (const step of steps) {
    const title = step.phase ?? "Steps";
    const last = phases.at(-1);
    if (last && last.title === title) last.steps.push(step);
    else phases.push({ title, steps: [step] });
  }
  return phases;
}

/**
 * A plan is named by the run it belongs to. People have the run id (from
 * `piorbit runs`, or from pi-subagents itself), not the panel id, so any
 * suffix of either works — and an ambiguous reference lists the candidates
 * rather than picking one.
 */
export function matchPlans(
  plans: ReadonlyArray<{ panel: PlanPanel; session: SessionSummary }>,
  reference: string,
): Array<{ panel: PlanPanel; session: SessionSummary }> {
  const exact = plans.filter((plan) => plan.panel.id === reference);
  if (exact.length > 0) return exact;
  return plans.filter((plan) => plan.panel.id.includes(reference) || plan.panel.title.includes(reference));
}

export const planCommand: Command = {
  name: "plan",
  group: "Sessions",
  summary: "show the shape of a multi-step run: phases, lanes and their steps",
  usage: `${PRODUCT_NAME} plan <run> [--project <dir>] [--json]`,
  description: `
Prints the plan behind a workflow, chain or parallel run: its phases, the steps
in each, which run each step became, and what they cost.

Structure the subagent extension persisted is shown as declared. Structure rebuilt
from a scripted workflow's trace is labelled INFERRED, because that package
persists no dependency graph and presenting one as fact would be a lie.

<run> is any unambiguous part of a run id — the ids \`${PRODUCT_NAME} runs\` prints.`,
  positionals: [{ name: "run", description: "run id, or any unambiguous part of one" }],
  flags: {
    project: { type: "string", description: "only look in this project directory" },
  },
  examples: [
    { command: `${PRODUCT_NAME} plan 9b65610d`, note: "by the run id the subagent extension uses" },
    { command: `${PRODUCT_NAME} plan 9b65610d --json`, note: "steps, states and usage as data" },
  ],
  async run(ctx) {
    const reference = ctx.args.positionals[0];
    if (reference === undefined) {
      throw new CliError("plan needs a run", {
        exitCode: ExitCode.Usage,
        fix: `\`${PRODUCT_NAME} runs\` lists them; pass any unambiguous part of a run id.`,
      });
    }

    const rpc = await connect(ctx.paths);
    try {
      const sessions = await sessionsInScope(rpc, ctx);
      const fleet = await readFleet(rpc, sessions);
      const matched = matchPlans(fleet.plans, reference);

      if (matched.length === 0) {
        const known = fleet.runs.some((row) => row.panel.id.includes(reference));
        throw new CliError(`no plan matches ${JSON.stringify(reference)}`, {
          fix: known
            ? `That run is a single step, so it has no plan. \`${PRODUCT_NAME} runs\` shows it.`
            : `\`${PRODUCT_NAME} runs\` lists what the host can see. A run pruned by retention is gone.`,
        });
      }
      if (matched.length > 1) {
        throw new CliError(`${JSON.stringify(reference)} matches ${matched.length} plans`, {
          exitCode: ExitCode.Usage,
          details: matched.slice(0, 8).map((plan) => `${plan.panel.id}  ${plan.panel.title}`),
          fix: "Use a longer id.",
        });
      }

      const { panel, session } = matched[0]!;
      const phases = groupPhases(panel.steps);
      const done = panel.steps.filter((step) => step.state === "done" || step.state === "skipped").length;
      const usage = usageCells(panel);

      ctx.term.data({
        id: panel.id,
        title: panel.title,
        objective: panel.objective ?? null,
        inferred: panel.inferred === true,
        done,
        total: panel.steps.length,
        usage: panel.usage ?? null,
        session: { path: session.path, cwd: session.cwd, id: session.id },
        phases: phases.map((phase) => ({
          title: phase.title,
          steps: phase.steps.map((step) => ({
            id: step.id,
            label: step.label,
            state: step.state,
            runId: step.runId ?? null,
            model: step.model ?? null,
            dependsOn: step.dependsOn ?? null,
            usage: step.usage ?? null,
            startedAt: step.startedAt ?? null,
            endedAt: step.endedAt ?? null,
          })),
        })),
      });

      ctx.term.print(ctx.term.out.bold(panel.title));
      if (panel.objective) ctx.term.print(ctx.term.out.dim(clip(panel.objective, 100)));
      const marks = [
        `${done}/${panel.steps.length} steps done`,
        `${usage.tokens} tokens`,
        usage.cost,
      ];
      if (panel.inferred) marks.push(ctx.term.out.yellow("inferred"));
      ctx.term.print(marks.join(ctx.term.out.dim(" · ")));
      if (panel.inferred) {
        ctx.term.note(
          ctx.term.err.dim("  this workflow persisted no structure; the phases were rebuilt from its trace and preflight lanes"),
        );
      }
      ctx.term.print();

      for (const phase of phases) {
        if (phases.length > 1 || phase.title !== "Steps") ctx.term.print(ctx.term.out.dim(phase.title));
        for (const line of table(
          phase.steps,
          [
            { header: "", get: (step) => mark(step.state, ctx.term.out) },
            { header: "step", get: (step) => step.label },
            { header: "state", get: (step) => STATE_WORD[step.state] },
            { header: "model", get: (step) => step.model ?? "—" },
            { header: "took", get: (step) => tookOf(step), align: "right" },
            { header: "tokens", get: (step) => stepTokens(step), align: "right" },
          ],
          ctx.term.out,
        )) {
          ctx.term.print(`  ${line}`);
        }
        ctx.term.print();
      }
      return ExitCode.Ok;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw describeRpcError(error, "could not read the plan");
    } finally {
      rpc.close();
    }
  },
};

/** One glyph per state. ASCII only: this is piped, mailed and pasted. */
function mark(state: PlanStep["state"], paint: { dim(t: string): string; red(t: string): string; cyan(t: string): string; yellow(t: string): string }): string {
  switch (state) {
    case "done":
      return paint.dim("+");
    case "running":
      return paint.cyan(">");
    case "failed":
      return paint.red("x");
    case "blocked":
      return paint.yellow("!");
    case "skipped":
      return paint.dim("-");
    default:
      return paint.dim("·");
  }
}

function tookOf(step: PlanStep): string {
  if (!step.startedAt) return "—";
  const start = Date.parse(step.startedAt);
  const end = step.endedAt ? Date.parse(step.endedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  return formatElapsed(Math.max(0, end - start));
}

function stepTokens(step: PlanStep): string {
  if (step.usage === null) return "not measured";
  if (step.usage === undefined) return "—";
  const total = [step.usage.input, step.usage.output].filter((n): n is number => typeof n === "number");
  return total.length === 0 ? "not measured" : total.reduce((a, b) => a + b, 0).toLocaleString("en-US");
}
