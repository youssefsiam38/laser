import { SW_SKIP_WAITING, SW_PUSH_CHANGED } from "@lasercode/protocol";
import { useEffect } from "react";

import { useIsMobile } from "@/hooks";
import {
  acceptNavigateMessage,
  asRawClient,
  createReconnectGuard,
  onServiceWorkerMessage,
  syncPushSubscription,
  useEnvironment,
  type PushSubscriptionJson,
} from "@/pwa";
import { useLaserStable } from "@/runtime";
import { InstallPrompt } from "./InstallPrompt.js";
import { MobileStack } from "./MobileStack.js";
import { InsecureOriginNotice, NotifyHint, OfflineNotice, UpdateReady } from "./Notices.js";

/**
 * Everything the phone adds to the shell, mounted once inside
 * `<LaserProvider>`: the reconnect guard and service-worker plumbing (every
 * width — a laptop lid does the same to a socket), and on a phone the notice
 * strip plus the install sheet.
 *
 * Decisions are deliberately *not* here. They render as cards above the
 * composer on every width (docs/ux-fleet.md "Questions", DESIGN.md
 * "Transcript"), through `PanelDecisionCards`, which is also what a fallback
 * dialog and a declared `decision` panel both become. One surface, one code
 * path; the phone gets bigger controls inside it, not a second component.
 */
export function MobileSurfaces() {
  const isMobile = useIsMobile();
  const env = useEnvironment();
  usePwaGuards();

  return (
    <>
      <MobileStack>
        <UpdateReady />
        {isMobile ? (
          <>
            <OfflineNotice env={env} />
            <InsecureOriginNotice env={env} />
            <NotifyHint />
          </>
        ) : null}
      </MobileStack>
      {isMobile ? <InstallPrompt env={env} /> : null}
    </>
  );
}

/**
 * Reconnect probing (`pwa/reconnect.ts`) and the worker's messages: a
 * notification tap while the app was open, and a rotated push subscription.
 */
function usePwaGuards(): void {
  const { client, actions } = useLaserStable();

  useEffect(() => {
    const raw = asRawClient(client);
    const guard = createReconnectGuard({
      get connection() {
        return client.connection;
      },
      probe: () => client.request("pi/worker/list", {}),
      ...(hasReconnect(client) ? { reconnect: (reason: string) => client.reconnect(reason) } : {}),
      close: () => client.close(),
      connect: () => client.connect(),
    });
    const off = onServiceWorkerMessage((data) => {
      const link = acceptNavigateMessage(data);
      if (link?.sessionPath) void actions.openSession(link.sessionPath);
      const changed = data as { type?: unknown; subscription?: unknown } | null;
      if (changed?.type === SW_PUSH_CHANGED && changed.subscription) {
        void syncPushSubscription(raw, changed.subscription as PushSubscriptionJson).catch(() => {});
      }
    });
    return () => {
      guard.dispose();
      off();
    };
  }, [client, actions]);
}

/** `HostClient.reconnect()` is requested, not yet present; use it when it exists. */
function hasReconnect(client: object): client is { reconnect(reason: string): void } {
  return typeof (client as { reconnect?: unknown }).reconnect === "function";
}
