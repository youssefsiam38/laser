/**
 * What the app does when it learns which environment it is in (RP-13 B).
 *
 * The rule this module exists to keep in one place: **a move between
 * environments, or a narrowing of the one we are in, throws away everything
 * derived from the old one — and nothing else does.** The first environment of
 * a page's life is not a move, and a reconnect into the same environment with
 * the same policy is not either; clearing in those cases would discard the
 * connection's own setup and cost a person their open session for nothing.
 *
 * It reads {@link ActivationResult} rather than re-deriving that decision from
 * booleans at the call site, and it runs *before* the connection opens, so a
 * session path from the environment this device has just left can never be
 * resumed against the host it has just reached.
 *
 * It is also where the bounded device cache is prepared (RP-10). The
 * acceptance carries a `ready` promise, and the client will not publish `open`
 * until it settles or its budget expires — so by the time the app is
 * connected, a previously seen conversation is either readable from memory or
 * honestly not cached at all. Preparation cannot fail the connection: a
 * refused cache is a state this device is in, not a reason to keep a person
 * from their host.
 */
import type { EnvironmentAcceptance } from "../client.js";
import type { Action } from "../store.js";
import { deviceStore, registerDeviceContentStore } from "./device-storage.js";
import { installTailCacheSink, tailCache } from "./tail-cache/index.js";
import type { EnvironmentDescriptor } from "@lasercode/protocol";
import { useRef } from "react";

export interface EnvironmentLifecycleDeps {
  /** Forget every attachment and resume watermark, synchronously. */
  forgetAttachments(): void;
  dispatch(action: Action): void;
  /**
   * Clear the app state and the provider-owned bookkeeping derived from an
   * environment. The module-level stores do not need telling: they subscribe
   * to the device store and re-read whatever namespace opens.
   */
  reset(): void;
  /** Adopt this environment's remembered destination, now that it is readable. */
  restoreDestination(): void;
}

export interface EnvironmentLifecycle {
  /** For `HostClientOptions.onEnvironment`: runs before the connection opens. */
  accept(descriptor: EnvironmentDescriptor): EnvironmentAcceptance;
  /** For `HostClientOptions.onEnvironmentFailure`. */
  fail(reason: string): void;
}

export function createEnvironmentLifecycle(deps: EnvironmentLifecycleDeps): EnvironmentLifecycle {
  const forget = (): void => {
    deps.forgetAttachments();
    deps.reset();
  };

  // One registration for the life of the page: "forget everything this browser
  // stored" has to reach the transcript cache too, and `device-storage.ts`
  // stays the only module that owns that recovery.
  registerDeviceContentStore({ clear: () => tailCache.clear("all") });
  installTailCacheSink();

  return {
    accept(descriptor) {
      const result = deviceStore.activate(descriptor);
      if (result.kind === "failure") {
        // Nothing could be made safe, so nothing is kept and the connection
        // does not open: the person is told, rather than served an app that
        // quietly remembers the wrong environment.
        forget();
        tailCache.deactivate();
        deviceStore.purgeLegacy();
        return { ok: false, reason: result.reason };
      }
      if (result.kind === "switched" || result.kind === "narrowed") forget();
      deps.dispatch({ type: "environment", environment: descriptor });
      // Device storage only opens here, so this is the first moment the
      // remembered destination can be read at all.
      deps.restoreDestination();
      // The cache prepares against the policy this environment declared, and
      // the connection waits for it — bounded, and never for a failure.
      return {
        ok: true,
        ready: tailCache.prepare(descriptor).catch(() => undefined),
        // The connection stopped waiting: the budget ran out, or this socket
        // was replaced. Whatever the preparation is still doing, this device
        // keeps nothing — a pass that lands a moment too late must not open a
        // cache the connection has already gone ahead without.
        onReadyExpired: () => tailCache.deactivate(),
      };
    },

    fail(reason) {
      deviceStore.deactivate();
      tailCache.deactivate();
      // The pre-environment keys are unsafe wherever this view turns out to be,
      // so they go even though it never learned where that is.
      deviceStore.purgeLegacy();
      forget();
      deps.dispatch({ type: "environmentError", message: reason });
    },
  };
}

/**
 * The key the screens below the provider are mounted under (RP-13).
 *
 * It changes when the environment's identity changes — a switch, or a failure
 * that leaves this view in no environment at all — so component-local state
 * (a log query, an MCP form, a resource page's fetched rows) cannot outlive
 * the environment it came from. Only client-local views go; the host keeps
 * every session, run and command it is holding.
 *
 * It deliberately does **not** change when the first environment arrives:
 * nothing can have been fetched from anywhere before the connection opens, so
 * remounting there would only throw away this connection's own startup — the
 * open session included.
 */
export function useEnvironmentSubtreeKey(environmentKey: string | undefined): string {
  const seen = useRef<{ key: string | undefined; established: boolean }>({ key: undefined, established: false });
  const subtree = useRef("environment");
  if (environmentKey !== seen.current.key) {
    if (seen.current.established) subtree.current = environmentKey ?? "no-environment";
    seen.current = { key: environmentKey, established: seen.current.established || environmentKey !== undefined };
  }
  return subtree.current;
}
