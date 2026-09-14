/**
 * The environment descriptor and its policy (RP-13).
 *
 * One host-authoritative answer to "what is this environment, and what may
 * *this* connection do in it". Local desktop, a self-hosted host reached over
 * the end-to-end encrypted relay, a hosted workspace and an organisation's
 * managed host all speak the same protocol and the same descriptor; what
 * differs between them is the label they declare and the grants they narrow
 * to. The relay is never a participant: it forwards the ciphertext that
 * happens to carry these bytes and cannot read or interpret them.
 *
 * Three rules hold everywhere below:
 *
 * 1. **Narrowing only.** An environment policy and a device grant may take
 *    scopes away and tighten cache limits. Neither can add a scope the method
 *    table did not grant, and neither can touch a method's reach.
 * 2. **Per proven actor.** A descriptor describes the connection that asked
 *    for it. The host proves the actor class at its own boundary; a request
 *    body never contributes to it.
 * 3. **Opaque identities only.** The environment is named by RP-9's public
 *    environment key and the caller by a salted, irreversible actor id. No
 *    device-list id, no public key, no environment UUID, no path.
 *
 * This module is engine-neutral and browser-safe: it imports no Node API and
 * nothing from the agent runtime.
 */
import { z } from "zod";
import { PRODUCT_DISPLAY_NAME } from "./identity.js";
import { ENVIRONMENT_KEY_PATTERN } from "./session-revision.js";
import { METHOD_SCOPES, type ActorClass, type MethodScope } from "./method-policy.js";

export const ENVIRONMENT_DESCRIBE_METHOD = "environment/describe";

/**
 * Descriptor generation. A client that cached a descriptor of another
 * generation discards everything it derived from it, rather than trying to
 * reconcile two shapes.
 */
export const ENVIRONMENT_CONTRACT_VERSION = "ep1";

/**
 * What kind of environment this is. A label, not a behaviour switch: no
 * deployment implies a narrowing on its own, because a person must be able to
 * read the policy that applies to them rather than infer it from a word.
 */
export type EnvironmentDeployment = "local" | "self_hosted" | "cloud" | "enterprise";

export const ENVIRONMENT_DEPLOYMENTS: readonly EnvironmentDeployment[] = [
  "local",
  "self_hosted",
  "cloud",
  "enterprise",
] as const;

/**
 * What a device may keep of a conversation (RP-10 consumes this; RP-13 only
 * declares it). Every field can be tightened by policy and by a device grant,
 * and none can be loosened.
 */
export interface CachePolicy {
  /** `disabled` forbids retaining any transcript content on the device. */
  transcripts: "allowed" | "disabled";
  maxSessions: number;
  maxBytes: number;
  maxEntriesPerSession: number;
  maxAgeHours: number;
  /** `none` forbids keeping even a bounded reference or thumbnail. */
  attachments: "reference" | "none";
  /** The device must have OS-backed encrypted storage or must not cache. */
  requireDeviceEncryption: boolean;
}

/** A narrowing patch: every field optional, and only ever tightening. */
export type CachePatch = { [K in keyof CachePolicy]?: CachePolicy[K] | undefined };

/** The policy in force when nobody narrowed anything. Preserves local behaviour. */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  transcripts: "allowed",
  maxSessions: 24,
  maxBytes: 32 * 1024 * 1024,
  maxEntriesPerSession: 200,
  maxAgeHours: 336,
  attachments: "reference",
  requireDeviceEncryption: false,
};

/**
 * How much of a *successful* read is written to the audit.
 *
 * `summary` counts them per actor per window; `each` writes a row apiece.
 * Refusals are never summarised away by this setting — they hold reserved
 * capacity of their own — but they are still bounded, and past that reserve
 * they are counted rather than written (`docs/environment-policy.md` §5).
 */
export type AuditReadMode = "summary" | "each";

export interface EnvironmentCapabilities {
  /** `session/revision` answers for this environment. */
  revisions: boolean;
  /** A proved-prefix `baseRevision` may be answered with a delta. */
  deltas: boolean;
  /** Bounded `pi/session/entries` windows. */
  snapshots: boolean;
  /** Authoritative reads without starting a worker (RP-12). */
  durableReads: boolean;
  /** Saved-history search. */
  search: boolean;
  /** Logs and the process inventory are reachable for *this* actor. */
  diagnostics: boolean;
  logs: boolean;
  /** Web Push registration is reachable for this actor. */
  push: boolean;
}

export interface EnvironmentDescriptor {
  contract: typeof ENVIRONMENT_CONTRACT_VERSION;
  /** This host's compiled release. The version handshake remains the gate. */
  version: string;
  /** RP-9's public, opaque environment key. The device cache namespace. */
  environmentKey: string;
  deployment: EnvironmentDeployment;
  /** Who the host proved this connection to be. `id` is opaque and salted. */
  actor: { class: ActorClass; id: string };
  capabilities: EnvironmentCapabilities;
  cache: CachePolicy;
  /** The scopes this actor may use, after table → policy → grant narrowing. */
  scopes: MethodScope[];
  /**
   * Methods refused to this actor *only* because they are local to the
   * machine. Sorted, and short by construction: a client can say "on this
   * computer" instead of discovering it by failing.
   */
  localOnly: string[];
}

/** What a paired device was granted. Supplied by the host, never by a frame. */
export interface DeviceGrants {
  /** Intersected with the environment's own scopes. Never widens. */
  scopes?: MethodScope[];
  /** Clamped against the environment's cache policy. Never loosens. */
  cache?: CachePatch;
}

/** The policy an operator configures. Every field narrows or labels. */
export interface EnvironmentPolicyInput {
  deployment?: EnvironmentDeployment;
  /** Scopes allowed to connections on this machine. */
  local?: { scopes?: MethodScope[] };
  /** Scopes allowed to paired devices. */
  remote?: { scopes?: MethodScope[] };
  cache?: CachePatch;
  audit?: { reads?: AuditReadMode };
}

/** The same policy after validation, with every default filled in. */
export interface EnvironmentPolicy {
  deployment: EnvironmentDeployment;
  local: { scopes: MethodScope[] };
  remote: { scopes: MethodScope[] };
  cache: CachePolicy;
  audit: { reads: AuditReadMode };
}

/** A configured policy that cannot be honoured. Never echoes a configured value. */
export class EnvironmentPolicyError extends Error {
  override readonly name = "EnvironmentPolicyError";
  constructor(message: string, readonly problems: readonly string[]) {
    super(message);
  }
}

const scopeSchema = z.enum(METHOD_SCOPES as unknown as [MethodScope, ...MethodScope[]]);
const deploymentSchema = z.enum(ENVIRONMENT_DEPLOYMENTS as unknown as [EnvironmentDeployment, ...EnvironmentDeployment[]]);

const cachePatchSchema = z
  .object({
    transcripts: z.enum(["allowed", "disabled"]).optional(),
    maxSessions: z.number().int().nonnegative().max(100_000).optional(),
    maxBytes: z.number().int().nonnegative().max(64 * 1024 * 1024 * 1024).optional(),
    maxEntriesPerSession: z.number().int().nonnegative().max(1_000_000).optional(),
    maxAgeHours: z.number().int().nonnegative().max(24 * 365 * 10).optional(),
    attachments: z.enum(["reference", "none"]).optional(),
    requireDeviceEncryption: z.boolean().optional(),
  })
  .strict();

/** The shape of a configured policy, from options or from a file. */
export const environmentPolicySchema = z
  .object({
    deployment: deploymentSchema.optional(),
    local: z.object({ scopes: z.array(scopeSchema).max(METHOD_SCOPES.length).optional() }).strict().optional(),
    remote: z.object({ scopes: z.array(scopeSchema).max(METHOD_SCOPES.length).optional() }).strict().optional(),
    cache: cachePatchSchema.optional(),
    audit: z.object({ reads: z.enum(["summary", "each"]).optional() }).strict().optional(),
  })
  .strict();

export const deviceGrantsSchema = z
  .object({
    scopes: z.array(scopeSchema).max(METHOD_SCOPES.length).optional(),
    cache: cachePatchSchema.optional(),
  })
  .strict();

/**
 * One problem sentence per issue, built from the field's path and the kind of
 * failure. Deliberately never the configured value: a policy may name internal
 * deployment details, and an error a person reads must still be safe to log.
 */
function policyProblems(issues: readonly z.ZodIssue[]): string[] {
  return issues.slice(0, 20).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "the policy";
    switch (issue.code) {
      case "invalid_type":
        return `${field} must be ${issue.expected}`;
      case "unrecognized_keys":
        return `${field} contains a field this version does not know`;
      case "invalid_enum_value":
        return `${field} is not one of the values this field allows`;
      case "too_small":
      case "too_big":
        return `${field} is outside the range this field allows`;
      default:
        return `${field} is not valid`;
    }
  });
}

/**
 * Validate and fill in a configured policy.
 *
 * A policy that was configured and cannot be parsed is a failure, never a
 * silent fall back to defaults: an operator who wrote a narrowing meant it,
 * and quietly running wide open is the one outcome that must not happen.
 *
 * `source` is a short human label ("the host's configured policy"), never a
 * path: this message is meant to be safe to show and safe to log.
 */
export function resolveEnvironmentPolicy(input: unknown, source: string): EnvironmentPolicy {
  const parsed = environmentPolicySchema.safeParse(input ?? {});
  if (!parsed.success) {
    const problems = policyProblems(parsed.error.issues);
    throw new EnvironmentPolicyError(
      `The environment policy from ${source} cannot be used: ${problems.join("; ")}. Correct it or remove it, then start ${PRODUCT_DISPLAY_NAME} again.`,
      problems,
    );
  }
  const value = parsed.data;
  return {
    deployment: value.deployment ?? "local",
    local: { scopes: intersectScopes(METHOD_SCOPES, value.local?.scopes) },
    remote: { scopes: intersectScopes(METHOD_SCOPES, value.remote?.scopes) },
    cache: clampCachePolicy(DEFAULT_CACHE_POLICY, value.cache),
    audit: { reads: value.audit?.reads ?? "summary" },
  };
}

/** Scope intersection: the result is always a subset of `base`, in table order. */
export function intersectScopes(base: readonly MethodScope[], patch?: readonly MethodScope[]): MethodScope[] {
  const allowed = new Set(base);
  const wanted = patch === undefined ? undefined : new Set(patch);
  return METHOD_SCOPES.filter((scope) => allowed.has(scope) && (wanted === undefined || wanted.has(scope)));
}

/**
 * Cache clamp: the result is never wider than `base` in any dimension.
 * `disabled` and `none` are sticky, encryption requirements only turn on, and
 * every limit takes the smaller of the two.
 */
export function clampCachePolicy(base: CachePolicy, patch?: CachePatch): CachePolicy {
  if (!patch) return { ...base };
  const min = (a: number, b: number | undefined): number => (typeof b === "number" ? Math.min(a, b) : a);
  return {
    transcripts: base.transcripts === "disabled" || patch.transcripts === "disabled" ? "disabled" : "allowed",
    maxSessions: min(base.maxSessions, patch.maxSessions),
    maxBytes: min(base.maxBytes, patch.maxBytes),
    maxEntriesPerSession: min(base.maxEntriesPerSession, patch.maxEntriesPerSession),
    maxAgeHours: min(base.maxAgeHours, patch.maxAgeHours),
    attachments: base.attachments === "none" || patch.attachments === "none" ? "none" : "reference",
    requireDeviceEncryption: base.requireDeviceEncryption || patch.requireDeviceEncryption === true,
  };
}

/** The descriptor's own shape, for round-trip tests and any future consumer. */
export const environmentDescriptorSchema = z
  .object({
    contract: z.literal(ENVIRONMENT_CONTRACT_VERSION),
    version: z.string().min(1),
    environmentKey: z.string().regex(ENVIRONMENT_KEY_PATTERN),
    deployment: deploymentSchema,
    actor: z
      .object({
        class: z.enum(["local_app", "local_browser", "paired_device"]),
        id: z.string().min(1).max(64),
      })
      .strict(),
    capabilities: z
      .object({
        revisions: z.boolean(),
        deltas: z.boolean(),
        snapshots: z.boolean(),
        durableReads: z.boolean(),
        search: z.boolean(),
        diagnostics: z.boolean(),
        logs: z.boolean(),
        push: z.boolean(),
      })
      .strict(),
    cache: z
      .object({
        transcripts: z.enum(["allowed", "disabled"]),
        maxSessions: z.number().int().nonnegative(),
        maxBytes: z.number().int().nonnegative(),
        maxEntriesPerSession: z.number().int().nonnegative(),
        maxAgeHours: z.number().int().nonnegative(),
        attachments: z.enum(["reference", "none"]),
        requireDeviceEncryption: z.boolean(),
      })
      .strict(),
    scopes: z.array(scopeSchema),
    localOnly: z.array(z.string().min(1)),
  })
  .strict();

/** Method → params, for the registry in `schemas.ts`. */
export const environmentParamsSchemas = {
  "environment/describe": z.object({}).strict(),
};

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * What this environment is and what this connection may do in it (RP-13).
     *
     * Answered for the connection that asks, from the host's own proof of who
     * it is. Always available to an authenticated connection: a client that
     * cannot ask this cannot tell the difference between "not allowed" and
     * "broken".
     */
    "environment/describe": {
      params: {};
      result: { environment: EnvironmentDescriptor };
    };
  }
}
