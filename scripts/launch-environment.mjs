import { identity } from "./identity/identity.mjs";

/**
 * Environment that belongs to one running app/host/worker generation, never to
 * a source checkout running verification:
 *
 * - the runtime triple binds children to one installed manifest;
 * - launch, feature and worker identities bind one exact process chain;
 * - feature, package-manager and task-log values are selected by that chain;
 * - agent and state directories bind it to the installed app's data instance.
 *
 * Keep this explicit rather than dropping the product prefix: variables such
 * as MCP_LIVE, NODE, PORT and UI_URL are legitimate inputs to focused tests.
 * A test that needs one of these launch values sets it inside its own process,
 * after the gate has removed the caller's installed-app environment.
 * Removing data-directory pins is not sandboxing: each test must still supply
 * isolated data roots. SESSION_DIR is a caller/test override, not app-injected.
 */
export const APP_LAUNCH_ENVIRONMENT_NAMES = Object.freeze([
  identity.env.runtimeGenerationId,
  identity.env.runtimeInstallRoot,
  identity.env.runtimeManifestDigest,
  identity.env.featureGenerationId,
  identity.env.hostLaunchId,
  identity.env.workerFd,
  identity.env.features,
  identity.env.npmCli,
  identity.env.npmCommand,
  identity.env.taskLogRoot,
  identity.env.agentDir,
  identity.env.stateDir,
]);

export function scrubAppLaunchEnvironment(input = process.env) {
  const env = { ...input };
  const removed = [];
  for (const name of APP_LAUNCH_ENVIRONMENT_NAMES) {
    if (!Object.hasOwn(env, name)) continue;
    delete env[name];
    removed.push(name);
  }
  return { env, removed };
}

export function appLaunchEnvironmentScrubMessage(scope, removed) {
  return removed.length > 0
    ? `${scope}: removed inherited app launch environment: ${removed.join(", ")}\n`
    : "";
}
