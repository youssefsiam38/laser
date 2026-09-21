/**
 * Beam, the app's own assistant: the spark, the bubble, the profile choice and
 * the mark on its sessions (docs/agents.md "Beam").
 */
export { BeamSpark, BEAM_BUBBLE_ID, type BeamSparkProps } from "./BeamSpark.js";
export { BeamBubble } from "./BeamBubble.js";
export { BeamEmptyState } from "./BeamEmptyState.js";
export { BeamProfileDialog, beamProfileDialog } from "./BeamProfileDialog.js";
export { BeamSessionMark } from "./BeamSessionMark.js";
export { beamStore, useBeam, type BeamSnapshot } from "./beam-store.js";
export {
  BEAM_DEFAULT_PROFILE_NOTE,
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
