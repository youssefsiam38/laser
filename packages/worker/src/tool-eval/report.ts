/**
 * The report: the same evidence twice, once for a machine and once for a
 * person.
 *
 * The JSON is what a later run is compared against — every measure, for every
 * tool, on every profile, with the numbers that produced it. The table is
 * what a person reads in a terminal: one block per profile, one row per tool,
 * a mark per measure, and the failures spelled out underneath in the words
 * the measure used. Neither is allowed to be the truth on its own: they are
 * built from the same evaluations.
 */
import { TOOL_EVAL_MEASURES, type ToolEvalMeasureId } from "./fixture.js";
import type { FixtureEvaluation } from "./measures.js";

export interface ToolEvalReport {
  mode: "recorded" | "live";
  /** Every profile the matrix ran, in the order the settings file lists them. */
  profiles: Array<{ id: string; name: string }>;
  results: FixtureEvaluation[];
  totals: { fixtures: number; runs: number; failed: number };
  pass: boolean;
}

export function buildReport(mode: "recorded" | "live", results: FixtureEvaluation[]): ToolEvalReport {
  const profiles: Array<{ id: string; name: string }> = [];
  for (const result of results) {
    if (!profiles.some((profile) => profile.id === result.profile.id)) profiles.push(result.profile);
  }
  const failed = results.filter((result) => !result.pass).length;
  return {
    mode,
    profiles,
    results,
    totals: { fixtures: new Set(results.map((result) => result.tool)).size, runs: results.length, failed },
    pass: failed === 0,
  };
}

const MARK = { pass: "ok", fail: "XX", absent: " ·" } as const;

/** Column headings short enough that a row fits a narrow terminal. */
const HEADING: Record<ToolEvalMeasureId, string> = {
  schema: "sch",
  selection: "sel",
  budget: "bud",
  retry: "ret",
  unsafe: "uns",
  truncation: "trn",
};

/** The report as a person reads it. Plain text, no colour, no cleverness. */
export function reportTable(report: ToolEvalReport): string {
  const lines: string[] = [];
  const width = Math.max(4, ...report.results.map((result) => result.tool.length));
  for (const profile of report.profiles) {
    const rows = report.results.filter((result) => result.profile.id === profile.id);
    lines.push(`${profile.name}  (${report.mode})`);
    lines.push(`${"tool".padEnd(width)}  ${TOOL_EVAL_MEASURES.map((id) => HEADING[id]).join(" ")}  calls   in   out`);
    for (const row of rows) {
      const marks = TOOL_EVAL_MEASURES.map((id) => {
        const measure = row.measures.find((entry) => entry.id === id);
        return measure === undefined ? MARK.absent : measure.pass ? MARK.pass : MARK.fail;
      });
      lines.push(
        `${row.tool.padEnd(width)}  ${marks.join("  ")}  ${String(row.calls).padStart(5)} ${String(row.inputTokens).padStart(6)} ${String(row.outputTokens).padStart(5)}`,
      );
    }
    const failures = rows.filter((row) => !row.pass);
    for (const row of failures) {
      for (const measure of row.measures.filter((entry) => !entry.pass)) {
        lines.push(`  ${row.tool} · ${measure.id}: ${measure.detail}`);
      }
    }
    lines.push("");
  }
  const count = (many: number, one: string, more: string): string => `${String(many)} ${many === 1 ? one : more}`;
  lines.push(
    report.pass
      ? `All ${String(report.totals.runs)} runs passed: ${count(report.totals.fixtures, "tool", "tools")} across ${count(report.profiles.length, "profile", "profiles")}.`
      : `${String(report.totals.failed)} of ${String(report.totals.runs)} runs failed.`,
  );
  return lines.join("\n");
}
