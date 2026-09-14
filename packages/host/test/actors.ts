/**
 * The proven callers a test can be (RP-13).
 *
 * `Router.handle` takes the actor the boundary proved, and it is required:
 * a call site that could leave it out would be one that silently defaults to
 * trusted. Tests name the caller they mean, exactly as the host does.
 */
import { localActor, pairedActor, type ActorIdentity } from "../src/access.js";
import type { DeviceGrants } from "@lasercode/protocol";

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
