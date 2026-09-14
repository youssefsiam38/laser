/**
 * The proven callers a test can be (RP-13).
 *
 * `Router.handle` takes the actor the boundary proved, and it is required:
 * a call site that could leave it out would be one that silently defaults to
 * trusted. Tests name the caller they mean, exactly as the host does.
 */
import { AccessControl, localActor, pairedActor, type ActorIdentity } from "../src/access.js";
import { resolveEnvironmentPolicy, type DeviceGrants } from "@lasercode/protocol";

/** The app shell or the command line: a loopback socket with no browser origin. */
export const LOCAL_APP: ActorIdentity = localActor(false);
/** A page this host serves, on this machine. */
export const LOCAL_BROWSER: ActorIdentity = localActor(true);

export const LOCAL_ACCESS = { actor: LOCAL_APP };
export const BROWSER_ACCESS = { actor: LOCAL_BROWSER };

/** A paired device, with an optional narrowing grant. */
export function deviceActor(grants?: DeviceGrants, environmentId = "test-environment"): ActorIdentity {
  return pairedActor(environmentId, new Uint8Array(32).fill(7), grants);
}

export function deviceAccess(grants?: DeviceGrants): { actor: ActorIdentity } {
  return { actor: deviceActor(grants) };
}

/**
 * The boundary every Router in a test is built with.
 *
 * `RouterDeps.access` is required, so a test cannot accidentally exercise a
 * Router with no authority behind it. The default narrows nothing, which is
 * what a local host does.
 */
export function testAccess(policy?: unknown, capabilities?: Partial<Record<string, boolean>>): AccessControl {
  return new AccessControl({
    policy: resolveEnvironmentPolicy(policy ?? {}, "the host's configured policy"),
    environmentKey: "e1.AAAAAAAAAAAAAAAAAAAAAA",
    capabilities: {
      revisions: true,
      deltas: true,
      snapshots: true,
      durableReads: true,
      search: true,
      logs: true,
      diagnostics: true,
      push: true,
      ...(capabilities as Record<string, boolean> | undefined),
    },
  });
}
