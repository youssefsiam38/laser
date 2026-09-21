/**
 * Verification and convergence, worker side (M21-T19).
 *
 * The run is here because a checkout is here; every judgement it reports is
 * the host's.
 */
export {
  notRun,
  runVerificationCommand,
  type RunCommandOptions,
  type VerificationCommandRunner,
} from "./commands.js";
export { VerificationRun, type VerificationRunOptions } from "./run.js";
export {
  VerificationRefused,
  VerificationService,
  VERIFICATION_ROW_INTERVAL_MS,
  VERIFICATION_RUNS_KEPT,
  type VerificationServiceOptions,
} from "./service.js";
export {
  VERIFY_PROJECT_TASK_SPEC,
  VERIFY_TOOL_RECOVERY,
  verifyProjectTask,
  type VerifyProjectTaskDeps,
  type VerifyProjectTaskInput,
} from "./tools.js";
