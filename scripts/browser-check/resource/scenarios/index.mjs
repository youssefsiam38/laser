/**
 * The nine RP-2 scenarios, in the order a run performs them, each behind the
 * same contract:
 *
 *   { id, ids?, title, run(soakRun) -> { phase, state? } }
 *
 * `run` receives the shared `SoakRun` and returns the phase sample that
 * evidences its completion. A scenario is marked complete only when that phase
 * is in the report, so "complete" always means "measured", never "reached".
 * Scenario 7 is the desktop lane and runs outside the browser case, from the
 * runner, at the scale its mode declares.
 */
import baseline from './01-baseline.mjs';
import distinctSessions from './02-distinct-sessions.mjs';
import backwardPagination from './03-backward-pagination.mjs';
import largeContent from './04-large-content-and-images.mjs';
import childrenAndBash from './05-children-and-bash.mjs';
import slowConsumer from './08-slow-consumer.mjs';
import detachAndRetirement from './09-detach-and-retirement.mjs';

export const BROWSER_SCENARIOS = [
  baseline, distinctSessions, backwardPagination, largeContent, childrenAndBash, slowConsumer, detachAndRetirement,
];
export const DESKTOP_SCENARIO = '7-desktop-hide-and-restore';
export const SCENARIO_IDS = [...BROWSER_SCENARIOS.flatMap(scenario => scenario.ids ?? [scenario.id]), DESKTOP_SCENARIO].sort();
