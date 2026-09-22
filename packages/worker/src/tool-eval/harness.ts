/**
 * The matrix: every fixture, on every configured profile.
 *
 * A tool is not conformant because it passed once on the model its author
 * happened to use. `docs/agent-tool-contract.md` §4 says every Laser tool is
 * run "on every configured Model Profile", so the unit of a run is the
 * fixture *times* the profile, and the report groups by profile. In a
 * recorded run the profile changes exactly one thing — the model id the
 * replayed answers are attributed to — which is honest about what a recording
 * can prove: the matrix is the shape, and a live run is what fills it with a
 * real model's own choices.
 */
import { readModelProfiles } from "../settings.js";
import type { ToolEvalFixture } from "./fixture.js";
import { evaluateRun, type FixtureEvaluation } from "./measures.js";
import { buildReport, type ToolEvalReport } from "./report.js";
import { profileMatrix, runFixture, type ToolEvalProfile } from "./run.js";

export interface EvaluateOptions {
  fixtures: ToolEvalFixture[];
  profiles: ToolEvalProfile[];
  /** The person's agent directory, for a live run. Absent for a recorded one. */
  liveAgentDir?: string;
  timeoutMs?: number;
  /** Called after each run, so a long matrix says where it is. */
  onResult?: (result: FixtureEvaluation) => void;
}

/** Run the whole matrix and report it. */
export async function evaluateFixtures(options: EvaluateOptions): Promise<ToolEvalReport> {
  const results: FixtureEvaluation[] = [];
  for (const profile of options.profiles) {
    for (const fixture of options.fixtures) {
      const run = await runFixture({
        fixture,
        profile,
        ...(options.liveAgentDir !== undefined ? { liveAgentDir: options.liveAgentDir } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const result = evaluateRun(run);
      results.push(result);
      options.onResult?.(result);
    }
  }
  return buildReport(options.liveAgentDir === undefined ? "recorded" : "live", results);
}

/**
 * The profiles a settings file configures, as the matrix needs them. The same
 * reader the product uses, so a person's own profiles and the fixtures'
 * profiles are read by one code path.
 */
export function profilesFrom(agentDir: string, only?: string): ToolEvalProfile[] {
  const profiles = profileMatrix(readModelProfiles(agentDir));
  if (profiles.length === 0) {
    throw new Error(
      `There are no Model Profiles in the settings at ${agentDir}, so there is no matrix to run. Open Settings → Providers and models once, so this installation has its profiles, or point --profiles at a settings file that has some.`,
    );
  }
  if (only === undefined) return profiles;
  const wanted = profiles.filter((profile) => profile.name.toLowerCase() === only.toLowerCase() || profile.id === only);
  if (wanted.length === 0) {
    throw new Error(`No profile called "${only}" is configured. The profiles there are: ${profiles.map((profile) => profile.name).join(", ") || "none"}.`);
  }
  return wanted;
}
