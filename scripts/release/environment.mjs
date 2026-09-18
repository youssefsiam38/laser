import { scrubAppLaunchEnvironment } from "../launch-environment.mjs";

/** Child isolation applies to both the orchestrator and the standalone publisher. */
export function sanitizedReleaseEnvironment(input = process.env) {
  const { env } = scrubAppLaunchEnvironment(input);
  // Git fixture repositories and linked worktrees must choose their own index/config.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
