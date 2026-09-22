/**
 * Foundation mode, worker side (M21-T14).
 *
 * `docs/design-phase.md`, "Case A · Foundation mode": a project with no index
 * and no UI source is designed by proposing a foundation first — ten steps in
 * a fixed order, each editable, stored in Laser state and nowhere near the
 * repository, and `proposed` until Build implements it.
 *
 * | File | Holds |
 * | --- | --- |
 * | `proposals.ts` | the ordered steps, one bounded completion each on the Design-index profile, strict JSON validated against the protocol schema, and the neutral fallback |
 * | `neutral.ts` | the documented neutral foundation a machine with no design profile is given, with the honest note |
 * | `licence.ts` | licence classification for icon, illustration, font and component sources; `unknown` blocks the recommendation |
 * | `storage.ts` | the proposal as a Design revision body, written through the host authority; no filesystem API is imported here |
 * | `tools.ts` | `propose_foundation`, step-wise, returning refs |
 */
export {
  FOUNDATION_LICENCE_CLASSES,
  KNOWN_SOURCES,
  checkSource,
  classifyLicence,
  declaredLicenceFrom,
  knownSource,
  type LicenceVerdict,
  type SourceCandidate,
} from "./licence.js";
export {
  FOUNDATION_FALLBACK_NOTE,
  FOUNDATION_MODEL_FALLBACK_NOTE,
  FOUNDATION_NO_PROFILE_FACT,
  foundationFallbackNote,
  NEUTRAL_COMPONENTS,
  NEUTRAL_PRINCIPLES,
  mergeTokens,
  neutralFoundation,
  neutralSources,
} from "./neutral.js";
export {
  FOUNDATION_TIMEOUT_MS,
  FoundationStepRefused,
  acceptFoundationStep,
  acceptedSummary,
  applyFoundationPatch,
  foundationBrief,
  foundationPrompt,
  parseFoundationJson,
  proposeFoundationStep,
  withStep,
  type FoundationInputs,
  type FoundationModelAccess,
  type FoundationStepProposal,
  type ProposeStepOptions,
} from "./proposals.js";
export {
  foundationBody,
  foundationBriefText,
  foundationDesignState,
  loadDesign,
  storeFoundation,
  type LoadedDesign,
  type StoredFoundation,
} from "./storage.js";
export {
  FOUNDATION_STEP_REFUSAL_NEXT,
  PROPOSE_FOUNDATION_RECOVERY,
  PROPOSE_FOUNDATION_SPEC,
  proposeFoundationTool,
  type FoundationBridge,
  type ProposeFoundationInput,
} from "./tools.js";
