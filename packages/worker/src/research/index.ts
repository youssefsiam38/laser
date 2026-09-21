/**
 * Research, worker side (M21-T26, `docs/research-phase.md`).
 *
 * The adapters, the readable-text extraction and digest cache they share, the
 * budget ledger that stops a run, the confidence rule, the four tools and the
 * playbook that runs the loop. The host is the authority for a write; the
 * protocol's `applyResearchOperation()` is the rule both sides run.
 */
export * from "./adapters/index.js";
export { ResearchLedger, ResearchBudgetRefused, researchBudgetLine, normaliseQuery, formatBytes, formatElapsed, type ResearchSpend } from "./budget.js";
export { fileResearchCache, memoryResearchCache, cacheKey, digestOf, type ResearchCache, type ResearchCacheEntry } from "./cache.js";
export { confidenceFor, reconcileConfidence, type ConfidenceInput, type ConfidenceVerdict } from "./confidence.js";
export { ResearchRefused, isKnownRefusal, type KnownRefusal } from "./errors.js";
export { readableText, injectionNotices, provenanceLine, decodeEntities, type ExtractedText, type InjectionNotice } from "./readable-text.js";
export {
  RECORD_FINDING_SPEC,
  RESOLVE_QUESTION_SPEC,
  RESEARCH_TOOL_RECOVERY,
  ResearchToolFailure,
  asToolFailure,
  readSourceSpec,
  readSourceTool,
  recordFindingTool,
  researchToolNames,
  researchToolSpecs,
  resolveQuestionTool,
  searchSourcesSpec,
  searchSourcesTool,
  type ReadSourceInput,
  type RecordFindingInput,
  type ResearchArtifact,
  type ResearchBridge,
  type ResearchWriteAck,
  type ResolveQuestionInput,
  type SearchSourcesInput,
} from "./tools.js";
export { ProjectResearch, adapterForSourceId, type ProjectResearchOptions, type ResearchStore } from "./bridge.js";
export { ResearchCommand, RESEARCH_PHASES, type ResearchCommandOptions, type ResearchCommandProgress, type ResearchPhase } from "./command.js";
export { researchPlaybook, researchPlaybookStep, RESEARCH_PLAYBOOK_STEPS, type ResearchPlaybookContext, type ResearchPlaybookStep } from "./playbook.js";
