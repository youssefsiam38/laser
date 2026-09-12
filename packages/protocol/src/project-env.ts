/**
 * Per-project environment command (M16-T17).
 *
 * A project may name one executable that decides the environment its commands
 * run with. Laser knows nothing about where those values come from: a secret
 * manager, a password store, a plain file, or nothing at all. It runs the
 * configured program and reads one versioned document from a private pipe.
 *
 * The contract, in full:
 *
 *   - Laser spawns `command` with `args`, working directory = the project root,
 *     stdin closed, and file descriptor 3 open for writing.
 *   - The program writes one JSON document to fd 3 and exits 0:
 *
 *       { "version": 1, "set": { "NAME": "value" }, "unset": ["NAME"] }
 *
 *   - stdout and stderr are treated as potentially sensitive. They are never
 *     rendered, never persisted and never put in a log or diagnostic.
 *   - A non-zero exit, a malformed document, an oversized document or a timeout
 *     is a failure. A project whose hook is required does not run commands with
 *     a wrong environment; it refuses them with a sanitised message.
 *
 * Nothing here is specific to any provider. The helper used on the author's
 * machine lives in a separate repository and is configured like any other.
 */
import { isProtectedEnvironmentKey } from "./environment.js";

/** The only contract version this build speaks. */
export const PROJECT_ENV_VERSION = 1;

/** Hard bounds. A hook cannot hang a project or exhaust its memory. */
export const PROJECT_ENV_TIMEOUT_MS = 20_000;
export const PROJECT_ENV_MAX_BYTES = 1024 * 1024;

/** The descriptor the document is written to. */
export const PROJECT_ENV_FD = 3;

/**
 * Model-provider credentials.
 *
 * These are refused by default, and the reason is concrete rather than
 * theoretical: real projects on the author's machine set `ANTHROPIC_API_KEY`
 * in their environment files, with different values per project. Letting a
 * project hook set one would silently repoint Laser's own model authentication
 * for every session in that project — the agent would start billing, or
 * failing, against a key the person never chose for it.
 *
 * A project that genuinely wants to give its commands a provider key (a test
 * suite that calls an API, say) opts in explicitly per project.
 */
export const PROVIDER_AUTH_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
];

const PROVIDER_AUTH_SET = new Set(PROVIDER_AUTH_KEYS);

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a project's environment command is, as configured. Never a secret. */
export interface ProjectEnvConfig {
  enabled: boolean;
  command: string;
  args: string[];
  /**
   * Whether a failure blocks the project's commands. True is the safe default:
   * running with a silently wrong environment is worse than not running.
   */
  required: boolean;
  /** Names from `PROVIDER_AUTH_KEYS` this project is allowed to set anyway. */
  allowProviderKeys?: string[];
  /**
   * The `{command, args}` fingerprint a person approved. A material change
   * makes the stored value stale and the hook does not run until it is
   * approved again.
   */
  approvedFingerprint?: string;
}

export type ProjectEnvState =
  | "off"
  | "not-configured"
  | "needs-approval"
  | "untrusted"
  | "ready"
  | "failed";

/** Everything a person may see about a project's environment. Names, never values. */
export interface ProjectEnvStatus {
  cwd: string;
  state: ProjectEnvState;
  config?: ProjectEnvConfig;
  /** Whether the stored fingerprint matches the configuration as it stands. */
  approved: boolean;
  /** Names the hook last set, sorted. Values never leave the worker. */
  names?: string[];
  unsetNames?: string[];
  /** When the current values were resolved. */
  resolvedAt?: string;
  /** A sanitised, person-facing explanation of the last failure. */
  error?: string;
}

/** The document a hook writes to fd 3. */
export interface ProjectEnvDocument {
  version: number;
  set: Record<string, string>;
  unset: string[];
}

/** The result of applying a document, ready for a status report. */
export interface ProjectEnvResolution {
  set: Record<string, string>;
  unset: string[];
  /** Names that were rejected, with the reason, so a person can be told why. */
  refused: Array<{ name: string; reason: string }>;
}

/**
 * A stable identity for what would actually be executed.
 *
 * Only the executable and its arguments are material: those decide what runs.
 * Everything else about a configuration can change without a new approval.
 */
export function projectEnvFingerprint(config: Pick<ProjectEnvConfig, "command" | "args">): string {
  return JSON.stringify([config.command, ...config.args]);
}

/** True when the configuration matches what the person approved. */
export function projectEnvApproved(config: ProjectEnvConfig | undefined): boolean {
  if (!config) return false;
  if (!config.approvedFingerprint) return false;
  return config.approvedFingerprint === projectEnvFingerprint(config);
}

/**
 * Validate a hook's document into the environment it is allowed to apply.
 *
 * Refusals are collected rather than thrown: a hook that names one forbidden
 * variable should still deliver the other forty, and the person should be able
 * to see which one was dropped and why — by name, never by value.
 */
export function projectEnvResolution(
  document: ProjectEnvDocument,
  options: { allowProviderKeys?: readonly string[] } = {},
): ProjectEnvResolution {
  const allowed = new Set(options.allowProviderKeys ?? []);
  const set: Record<string, string> = {};
  const unset: string[] = [];
  const refused: Array<{ name: string; reason: string }> = [];

  for (const [name, value] of Object.entries(document.set ?? {})) {
    if (!NAME_PATTERN.test(name)) {
      refused.push({ name: redactName(name), reason: "not a valid variable name" });
      continue;
    }
    if (typeof value !== "string" || value.includes("\0")) {
      refused.push({ name, reason: "the value is not usable text" });
      continue;
    }
    if (isProtectedEnvironmentKey(name)) {
      refused.push({ name, reason: "reserved by the app or the runtime" });
      continue;
    }
    if (PROVIDER_AUTH_SET.has(name) && !allowed.has(name)) {
      refused.push({ name, reason: "a model-provider credential; allow it for this project to use it" });
      continue;
    }
    set[name] = value;
  }

  for (const name of document.unset ?? []) {
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) continue;
    if (isProtectedEnvironmentKey(name)) continue;
    if (name in set) continue;
    unset.push(name);
  }

  return { set, unset: [...new Set(unset)].sort(), refused };
}

/** A name that failed validation may itself be junk; keep it short and printable. */
function redactName(name: string): string {
  const printable = name.replace(/[^\x20-\x7e]/g, "");
  return printable.length > 32 ? `${printable.slice(0, 32)}…` : printable || "(unnamed)";
}

/** Parse a hook's bytes into a document, or explain why they are unusable. */
export function parseProjectEnvDocument(text: string): { document: ProjectEnvDocument } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "The environment command did not return readable output." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The environment command did not return an object." };
  }
  const candidate = parsed as Partial<ProjectEnvDocument>;
  if (candidate.version !== PROJECT_ENV_VERSION) {
    return {
      error:
        `The environment command speaks version ${String(candidate.version ?? "unknown")}, ` +
        `and this version of the app understands version ${PROJECT_ENV_VERSION}.`,
    };
  }
  const set = candidate.set;
  if (set !== undefined && (typeof set !== "object" || set === null || Array.isArray(set))) {
    return { error: "The environment command's list of variables to set is not an object." };
  }
  const unset = candidate.unset;
  if (unset !== undefined && !Array.isArray(unset)) {
    return { error: "The environment command's list of variables to remove is not a list." };
  }
  return {
    document: {
      version: PROJECT_ENV_VERSION,
      set: (set ?? {}) as Record<string, string>,
      unset: (unset ?? []) as string[],
    },
  };
}

/** The non-secret configuration a worker is started with. */
export interface ProjectEnvWorkerConfig {
  enabled: boolean;
  command: string;
  args: string[];
  required: boolean;
  allowProviderKeys: string[];
  approved: boolean;
}

export function projectEnvWorkerConfig(config: ProjectEnvConfig | undefined): ProjectEnvWorkerConfig | undefined {
  if (!config || !config.enabled) return undefined;
  return {
    enabled: true,
    command: config.command,
    args: [...config.args],
    required: config.required,
    allowProviderKeys: [...(config.allowProviderKeys ?? [])],
    approved: projectEnvApproved(config),
  };
}
