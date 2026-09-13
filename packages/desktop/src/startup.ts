/**
 * The two things the host has to have before it starts, resolved together.
 *
 * Both are waiting, not working: the keychain is a native call that can sit on
 * an unlock prompt, and the shell environment is a login shell printing its
 * exports (`shell-environment.ts` allows it ten seconds). They have nothing to
 * say to each other, so running them one after the other simply adds their two
 * waits together in front of every launch.
 *
 * Two properties this keeps, and they are the reason it is a function rather
 * than two lines inline:
 *
 *  - The keychain is asked *first*, so an unlock prompt is still the first
 *    thing a person sees rather than something that interrupts them later.
 *  - Neither failure is fatal. A machine with no keyring runs with a file
 *    identity (`keychain.ts` says so in the UI), and a shell that will not
 *    print its environment leaves the app with the environment it already has.
 *
 * The shell environment is *not* optional for an adopted host: `HostProcess`
 * pushes it to a host that is already running (`refreshHostEnvironment`), so
 * adoption waits for it like a fresh spawn does.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";

import type { DesktopSecrets } from "./keychain.js";
import type { DesktopLog } from "./log.js";
import type { IdentitySummary } from "./api.js";

export interface StartupInputs {
  /** Undefined when the identity could not be loaded at all. */
  identity: IdentitySummary | undefined;
  /** Empty when the shell could not be asked; never a reason to stop. */
  shellEnvironment: Record<string, string>;
}

export async function resolveStartupInputs(deps: {
  secrets: () => Promise<DesktopSecrets>;
  shellEnvironment: () => Promise<Record<string, string>>;
  log: DesktopLog;
}): Promise<StartupInputs> {
  const { log } = deps;
  // Evaluation order is the promise-start order: the keychain call is made
  // before the shell is spawned, so its prompt still comes first.
  const secrets = deps.secrets();
  const shell = deps.shellEnvironment();
  const [identityResult, environmentResult] = await Promise.allSettled([secrets, shell]);

  let identity: IdentitySummary | undefined;
  if (identityResult.status === "fulfilled") {
    identity = identityResult.value.summary;
    log.line(`identity ${identity.deviceId} from ${identity.storage}`);
  } else {
    log.error(`could not load the ${PRODUCT_NAME} identity`, identityResult.reason);
  }

  if (environmentResult.status === "rejected") {
    // `resolveShellEnvironment` answers with `{}` rather than rejecting; this
    // is the belt for the day it throws. No cause is logged: a failure from a
    // profile script can quote the environment it was reading.
    log.line("Shell environment unavailable; keeping the current environment.");
  }

  return {
    identity,
    shellEnvironment: environmentResult.status === "fulfilled" ? environmentResult.value : {},
  };
}
