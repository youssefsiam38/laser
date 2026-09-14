/**
 * The host boundary's authorization (RP-13).
 *
 * Every client request arrives with a **proven** actor: the socket boundary
 * knows whether it accepted a loopback process, a loopback page or a paired
 * device whose Noise handshake authenticated its static key. Nothing in a
 * request body contributes to that, which is why the identity lives in the
 * call's context rather than in its params.
 *
 * Authorization is two independent gates, evaluated in this order and both
 * before the request is parsed:
 *
 * 1. **reach** — a property of the method (`@lasercode/protocol`'s method
 *    table). Nobody can widen or narrow it: `pi/host/environment` and
 *    `resource/report` are the app's own local business and stay that way.
 * 2. **scope** — the authority the method exercises, which an environment
 *    policy and a device grant may take away. Never add: both compose by
 *    intersection, so a grant that names more than the environment allows
 *    is silently the same as one that names less.
 *
 * The descriptor this module builds is the same answer from the other side:
 * what the environment is, what this connection may do in it, and what it
 * could only do from the machine itself.
 */
import {
  DEFAULT_CACHE_POLICY,
  ENVIRONMENT_CONTRACT_VERSION,
  ErrorCodes,
  METHOD_POLICY,
  METHOD_SCOPES,
  PRODUCT_VERSION,
  ProtocolError,
  WIRE_NAMESPACE,
  clampCachePolicy,
  intersectScopes,
  methodPolicy,
  notificationScope,
  reachAllows,
  type ActorClass,
  type CachePolicy,
  type DeviceGrants,
  type EnvironmentCapabilities,
  type EnvironmentDescriptor,
  type EnvironmentPolicy,
  type MethodPolicy,
  type MethodScope,
} from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";

/**
 * Who the host proved this connection to be.
 *
 * `id` is opaque and salted with this environment's private identity, so it is
 * stable for as long as the pairing is, irreversible to somebody holding the
 * device's public key, and different in another environment. The raw device
 * key, the signed list's device id and the environment's own UUID never leave
 * the trusted process.
 */
export interface ActorIdentity {
  class: ActorClass;
  id: string;
  /** Narrowing attached to a paired device by the host. Never from a frame. */
  grants?: DeviceGrants | undefined;
}

/** What `Router.handle` needs about the caller. Required at every call site. */
export interface RequestAccess {
  actor: ActorIdentity;
}

export type AuthorizationRefusal =
  | { ok: false; reason: "unknown_method"; error: ProtocolError }
  | { ok: false; reason: "reach" | "scope"; error: ProtocolError; policy: MethodPolicy };

export type Authorization = { ok: true; policy: MethodPolicy } | AuthorizationRefusal;

/** The two local actors need no derivation: there is one of each per machine. */
export const LOCAL_APP_ACTOR_ID = "l1.app";
export const LOCAL_BROWSER_ACTOR_ID = "l1.browser";
/**
 * A socket the host cannot prove came from this machine. Nothing creates one
 * today — the host binds loopback and remote access goes through the relay —
 * but an operator who binds elsewhere must not thereby hand out local
 * authority. Such a socket is treated as the least privileged class there is,
 * with an id of its own so the audit never confuses it with a paired device.
 */
export const UNPROVEN_SOCKET_ACTOR_ID = "r1.socket";

/**
 * The actor of a socket on this host's own listener.
 *
 * `loopback` is the host's own proof (the peer address), and `hasBrowserOrigin`
 * is the browser's mandatory `Origin` header: a page always sends one, so its
 * absence on a loopback socket is what identifies the shell or the command
 * line. Neither comes from the request body.
 */
export function localActor(hasBrowserOrigin: boolean, loopback = true): ActorIdentity {
  if (!loopback) return { class: "paired_device", id: UNPROVEN_SOCKET_ACTOR_ID };
  return hasBrowserOrigin
    ? { class: "local_browser", id: LOCAL_BROWSER_ACTOR_ID }
    : { class: "local_app", id: LOCAL_APP_ACTOR_ID };
}

/** The opaque actor id of a paired device, salted with the environment identity. */
export function pairedActorId(environmentId: string, devicePublicKey: Uint8Array): string {
  let key = "";
  for (const byte of devicePublicKey) key += byte.toString(16).padStart(2, "0");
  return `d1.${nodeRevisionHasher(`${WIRE_NAMESPACE}|actor|${environmentId}|${key}`).slice(0, 22)}`;
}

export function pairedActor(
  environmentId: string,
  devicePublicKey: Uint8Array,
  grants?: DeviceGrants | undefined,
): ActorIdentity {
  return { class: "paired_device", id: pairedActorId(environmentId, devicePublicKey), ...(grants ? { grants } : {}) };
}

/** What this host can actually do, as opposed to what it is allowed to do. */
export interface HostCapabilities {
  revisions: boolean;
  deltas: boolean;
  snapshots: boolean;
  durableReads: boolean;
  search: boolean;
  logs: boolean;
  diagnostics: boolean;
  push: boolean;
}

export interface AccessControlOptions {
  policy: EnvironmentPolicy;
  /** RP-9's public environment key. The device cache namespace, nothing more. */
  environmentKey: string;
  /** What this host has wired up; capabilities are the intersection with policy. */
  capabilities: HostCapabilities;
  version?: string;
}

/** The scope refusal sentence. One per scope, written for a person. */
const SCOPE_REFUSAL: Record<MethodScope, string> = {
  handshake: "This connection is not allowed to talk to this environment.",
  read: "This connection is not allowed to read conversations in this environment.",
  session_write: "This connection is not allowed to change conversations in this environment.",
  approval: "This connection is not allowed to answer questions or approve tools in this environment.",
  work_control: "This connection is not allowed to start or stop work in this environment.",
  settings: "This connection is not allowed to change settings in this environment.",
  features: "This connection is not allowed to change features in this environment.",
  diagnostics: "This connection is not allowed to read diagnostics in this environment.",
  device: "This connection is not allowed to manage notifications in this environment.",
};

export class AccessControl {
  private readonly localOnlyMethods: readonly string[];

  constructor(private readonly options: AccessControlOptions) {
    this.localOnlyMethods = Object.entries(METHOD_POLICY)
      .filter(([, policy]) => policy.reach !== "any")
      .map(([method]) => method)
      .sort();
  }

  get policy(): EnvironmentPolicy {
    return this.options.policy;
  }

  /** The scopes an actor may use: environment policy ∩ its own grant. */
  scopesFor(actor: ActorIdentity): MethodScope[] {
    const configured = actor.class === "paired_device" ? this.options.policy.remote.scopes : this.options.policy.local.scopes;
    return intersectScopes(configured, actor.grants?.scopes);
  }

  /** The cache policy for an actor: environment policy, clamped by its grant. */
  cacheFor(actor: ActorIdentity): CachePolicy {
    return clampCachePolicy(clampCachePolicy(DEFAULT_CACHE_POLICY, this.options.policy.cache), actor.grants?.cache);
  }

  /**
   * May this actor call this method? Answered from the method name alone, so
   * it can be decided before the params are parsed and before anything is
   * looked up, opened, spawned or changed.
   */
  authorize(method: string, actor: ActorIdentity): Authorization {
    const policy = methodPolicy(method);
    if (!policy) {
      return {
        ok: false,
        reason: "unknown_method",
        error: new ProtocolError(ErrorCodes.MethodNotFound, `unknown method ${method}`),
      };
    }
    if (!reachAllows(policy.reach, actor.class)) {
      return {
        ok: false,
        reason: "reach",
        policy,
        error: new ProtocolError(ErrorCodes.Unsupported, policy.refusal ?? SCOPE_REFUSAL[policy.scope]),
      };
    }
    if (!this.scopesFor(actor).includes(policy.scope)) {
      return {
        ok: false,
        reason: "scope",
        policy,
        error: new ProtocolError(ErrorCodes.Unsupported, SCOPE_REFUSAL[policy.scope]),
      };
    }
    return { ok: true, policy };
  }

  /** May this actor be sent this host notification? Unknown ones are not sent. */
  allowsNotification(method: string, actor: ActorIdentity): boolean {
    const scope = notificationScope(method);
    if (!scope) return false;
    return this.scopesFor(actor).includes(scope);
  }

  /** What this connection is looking at, in its own terms. */
  describe(actor: ActorIdentity): EnvironmentDescriptor {
    const scopes = this.scopesFor(actor);
    const has = (scope: MethodScope): boolean => scopes.includes(scope);
    const capabilities = this.options.capabilities;
    const descriptor: EnvironmentDescriptor = {
      contract: ENVIRONMENT_CONTRACT_VERSION,
      version: this.options.version ?? PRODUCT_VERSION,
      environmentKey: this.options.environmentKey,
      deployment: this.options.policy.deployment,
      actor: { class: actor.class, id: actor.id },
      capabilities: {
        revisions: capabilities.revisions && has("read"),
        deltas: capabilities.deltas && has("read"),
        snapshots: capabilities.snapshots && has("read"),
        durableReads: capabilities.durableReads && has("read"),
        search: capabilities.search && has("read"),
        diagnostics: capabilities.diagnostics && has("diagnostics"),
        logs: capabilities.logs && has("diagnostics"),
        push: capabilities.push && has("device"),
      } satisfies EnvironmentCapabilities,
      cache: this.cacheFor(actor),
      scopes,
      localOnly: this.localOnlyMethods.filter((method) => {
        const policy = methodPolicy(method);
        return policy !== undefined && !reachAllows(policy.reach, actor.class);
      }),
    };
    return descriptor;
  }
}

/**
 * The boundary a host gets when nobody wired one: the default policy, which
 * narrows nothing. Reach is still enforced — it belongs to the method, not to
 * a policy — and the scopes are exactly the table's own. It cannot describe an
 * environment, because a host that did not supply its identity has none to
 * name; `environment/describe` is refused instead of answered with a fiction.
 */
let fallback: AccessControl | undefined;
export function defaultAccessControl(): AccessControl {
  return (fallback ??= new AccessControl({
    policy: {
      deployment: "local",
      local: { scopes: [...METHOD_SCOPES] },
      remote: { scopes: [...METHOD_SCOPES] },
      cache: { ...DEFAULT_CACHE_POLICY },
      audit: { reads: "summary" },
    },
    environmentKey: "",
    capabilities: {
      revisions: false,
      deltas: false,
      snapshots: false,
      durableReads: false,
      search: false,
      logs: false,
      diagnostics: false,
      push: false,
    },
  }));
}
