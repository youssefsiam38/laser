/**
 * Beam, the app's own assistant: the spark, the bubble, the model choice and
 * the mark on its sessions (docs/agents.md "Beam").
 */
export { BeamSpark, BEAM_BUBBLE_ID, type BeamSparkProps } from "./BeamSpark.js";
export { BeamBubble } from "./BeamBubble.js";
export { BeamEmptyState } from "./BeamEmptyState.js";
export { BeamModelDialog } from "./BeamModelDialog.js";
export { BeamSessionMark } from "./BeamSessionMark.js";
export { beamStore, useBeam, BEAM_SESSION_STORAGE_KEY, type BeamSnapshot } from "./beam-store.js";
export {
  BEAM_DEFAULT_MODEL_NOTE,
  BEAM_FOLLOW_UPS,
  BEAM_NAME,
  BEAM_PURPOSE,
  BEAM_SUGGESTIONS,
  BEAM_TAGLINE,
  BEAM_UNAVAILABLE,
  beamWorkspace,
  bubbleOrigin,
  isBeamSession,
  startBeamSession,
} from "./beam-model.js";
