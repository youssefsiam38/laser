/**
 * The worker's project-work area (M21-T17): the typed bridge to the host
 * authority, the four lifecycle tools over it, the implementation context
 * packet, the `/design implement` hand-off, and the session assembly the
 * companion extension consumes.
 */
export {
  HostProjectWorkBridge,
  ProjectWorkToolFailure,
  projectWorkFailure,
  refuseProjectWork,
  type ProjectWorkBridge,
  type ProjectWorkExecutionShape,
  type ProjectWorkHostLink,
  type ProjectWorkSessionIdentity,
} from "./bridge.js";
export {
  INSPECT_PROJECT_WORK_SPEC,
  PROJECT_WORK_TOOL_RECOVERY,
  PROJECT_WORK_TOOL_SPECS,
  REPORT_PROJECT_TASK_SPEC,
  REQUEST_PROJECT_REVIEW_SPEC,
  WRITE_PROJECT_ARTIFACT_SPEC,
  inspectProjectWork,
  reportProjectTask,
  requestProjectReview,
  writeProjectArtifact,
  type InspectProjectWorkInput,
  type ReportProjectTaskInput,
  type RequestProjectReviewInput,
  type WriteProjectArtifactInput,
} from "./tools.js";
export {
  CONTEXT_PACKET_COMMENTS_MAX,
  CONTEXT_PACKET_MAX,
  buildContextPacket,
  type ContextPacket,
  type ContextPacketOptions,
} from "./context-packet.js";
export {
  DESIGN_IMPLEMENT_PATTERN,
  buildDesignHandoff,
  designImplementRef,
  type DesignHandoffPacket,
} from "./design-handoff.js";
export { ProjectWorkSession, type ProjectWorkSessionOptions } from "./session.js";
export {
  VERIFICATION_RUNS_KEPT,
  VERIFY_PROJECT_TASK_SPEC,
  VERIFY_TOOL_RECOVERY,
  VerificationRun,
  VerificationService,
  notRun,
  runVerificationCommand,
  verifyProjectTask,
  type RunCommandOptions,
  type VerificationCommandRunner,
  type VerificationRunOptions,
  type VerificationServiceOptions,
  type VerifyProjectTaskDeps,
  type VerifyProjectTaskInput,
} from "./verification/index.js";
