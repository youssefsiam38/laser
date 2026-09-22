/**
 * The tool evaluation harness (M26-T3, `docs/agent-tool-contract.md` §4).
 *
 * A unit-test-style runner over recorded provider responses, plus the live
 * run a person starts themselves. Not a browser check (D-342): nothing here
 * opens, drives or asserts on a user interface.
 */
export { loadFixtures, parseFixture, TOOL_EVAL_MEASURES, type RecordedStep, type ToolEvalBudget, type ToolEvalFixture, type ToolEvalMeasureId, type ToolEvalWorld, type ToolEvalWorldAgent } from "./fixture.js";
export { evaluateFixtures, profilesFrom, type EvaluateOptions } from "./harness.js";
export { DEFAULT_TRUNCATION_BYTES, evaluateRun, violations, type FixtureEvaluation, type MeasureResult } from "./measures.js";
export { estimateTokens, startRecordedProvider, type RecordedProvider } from "./recorded-provider.js";
export { recordedOutcomeMismatch } from "./measures.js";
export { buildReport, reportTable, type ToolEvalReport } from "./report.js";
export { profileMatrix, runFixture, type ObservedCall, type RunFixtureOptions, type ToolEvalProfile, type ToolEvalRun } from "./run.js";
export { validateArguments, type ArgumentViolation } from "./schema-check.js";

export { ScriptedWorld, type WorldCommand } from "./world.js";
