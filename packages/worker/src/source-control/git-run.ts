/**
 * Re-export the shared git runner. Host cleanup uses the same module so
 * timeout, overflow and GIT_* scrubbing cannot drift.
 */
export { gitEnv, runGit, type GitRunOptions, type GitRunResult } from "@lasercode/protocol/git-run";
