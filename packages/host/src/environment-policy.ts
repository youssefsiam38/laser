/**
 * Where the environment policy comes from (RP-13).
 *
 * Two sources, and they are **not** equivalent:
 *
 * - **The host's configured policy** (`HostServerOptions.policy`) is
 *   authoritative. It is supplied by whatever started this host — the desktop
 *   shell, a hosted workspace's supervisor, an organisation's deployment — and
 *   it is the only place a deployment may call itself `cloud` or `enterprise`.
 * - **This environment's policy file** (`<stateDir>/policy.json`) is an
 *   optional local narrowing, nothing more. The state directory belongs to the
 *   person running the app, so a file in it can only ever take authority away
 *   from that same person's own connections. It is *not* managed enforcement:
 *   deleting it returns the host to the configured policy, and nothing here
 *   pretends otherwise.
 *
 * A source that is present and unusable fails host initialisation, before the
 * host listens, with a sentence naming the field and never its value. Falling
 * back to defaults would answer a narrowing nobody can see with an environment
 * wider than the one that was asked for, which is the one outcome that must
 * not happen quietly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CACHE_POLICY,
  EnvironmentPolicyError,
  clampCachePolicy,
  environmentPolicySchema,
  intersectScopes,
  resolveEnvironmentPolicy,
  type EnvironmentPolicy,
  type EnvironmentPolicyInput,
} from "@lasercode/protocol";

export const ENVIRONMENT_POLICY_FILE = "policy.json";

/** A short label per source. Never a path: this text is shown and logged. */
export const CONFIGURED_POLICY_SOURCE = "the host's configured policy";
export const FILE_POLICY_SOURCE = "this environment's policy file";

export interface LoadedEnvironmentPolicy {
  policy: EnvironmentPolicy;
  /** The labels that contributed, for one honest log line at startup. */
  sources: string[];
}

export interface LoadEnvironmentPolicyOptions {
  stateDir: string;
  /** The authoritative policy, from whoever started this host. */
  configured?: EnvironmentPolicyInput | undefined;
  /** Test seam. Returns undefined when there is no file at all. */
  readPolicyFile?: (path: string) => string | undefined;
}

function defaultReadPolicyFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new EnvironmentPolicyError(
      `The environment policy from ${FILE_POLICY_SOURCE} cannot be read. Check the file's permissions or remove it.`,
      ["the policy file could not be read"],
    );
  }
}

/**
 * Resolve the policy this host runs under.
 *
 * The configured policy is the base; the file may only narrow it further. The
 * file may not name a deployment: a user-writable file must not be able to
 * call this machine an organisation's managed environment.
 */
export function loadEnvironmentPolicy(options: LoadEnvironmentPolicyOptions): LoadedEnvironmentPolicy {
  const sources: string[] = [];
  const base = resolveEnvironmentPolicy(options.configured ?? {}, CONFIGURED_POLICY_SOURCE);
  if (options.configured !== undefined) sources.push(CONFIGURED_POLICY_SOURCE);

  const read = options.readPolicyFile ?? defaultReadPolicyFile;
  const text = read(join(options.stateDir, ENVIRONMENT_POLICY_FILE));
  if (text === undefined) return { policy: base, sources };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnvironmentPolicyError(
      `The environment policy from ${FILE_POLICY_SOURCE} is not valid JSON. Correct it or remove it.`,
      ["the policy file is not valid JSON"],
    );
  }
  const shape = environmentPolicySchema.safeParse(parsed);
  if (shape.success && shape.data.deployment !== undefined) {
    throw new EnvironmentPolicyError(
      `The environment policy from ${FILE_POLICY_SOURCE} cannot set the deployment: only the host's configured policy names an environment. Remove that field.`,
      ["deployment is not a field this source may set"],
    );
  }
  // Validation, defaults and the same redacted problem sentences.
  const file = resolveEnvironmentPolicy(parsed, FILE_POLICY_SOURCE);
  sources.push(FILE_POLICY_SOURCE);

  return {
    policy: {
      // Only the authoritative source names the deployment.
      deployment: base.deployment,
      local: { scopes: intersectScopes(base.local.scopes, file.local.scopes) },
      remote: { scopes: intersectScopes(base.remote.scopes, file.remote.scopes) },
      cache: clampCachePolicy(clampCachePolicy(DEFAULT_CACHE_POLICY, base.cache), file.cache),
      // Auditing only ever goes up: a local file can ask for more records, not fewer.
      audit: { reads: base.audit.reads === "each" || file.audit.reads === "each" ? "each" : "summary" },
    },
    sources,
  };
}
