import { PRODUCT_NAME } from "@lasercode/protocol";
import { Bell, BellOff, BellRing, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { asRawClient, useEnvironment, usePush } from "@/pwa";
import { usePiorbitStable } from "@/runtime";

/**
 * The push control. Every state is a sentence, not a disabled switch:
 * why it is off here, and what turns it on (R2, capability honesty). Lane B
 * can mount this row in the settings screen as is.
 */
export function NotificationsSetting({ className }: { className?: string }) {
  const { client } = usePiorbitStable();
  const env = useEnvironment();
  const push = usePush(asRawClient(client), env);
  const a = push.availability;

  return (
    <section data-slot="notifications-setting" aria-labelledby="notifications-title" className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        {a.state === "ready" && push.subscribed ? (
          <BellRing aria-hidden="true" className="size-4 text-live" />
        ) : a.state === "denied" ? (
          <BellOff aria-hidden="true" className="size-4 text-ink-3" />
        ) : (
          <Bell aria-hidden="true" className="size-4 text-ink-3" />
        )}
        <h3 id="notifications-title" className="text-base font-medium text-ink">
          Notifications
        </h3>
        {a.state === "ready" && push.subscribed ? <span className="ms-auto text-xs text-ok">On for this device</span> : null}
      </div>

      {a.state === "unsupported" ? (
        <p className="text-sm text-ink-2">{a.reason}</p>
      ) : a.state === "needs-home-screen" ? (
        <p className="text-sm text-ink-2">
          On iPhone, notifications only work once {PRODUCT_NAME} is on the Home Screen. In Safari tap <span className="font-medium text-ink">Share</span>, then{" "}
          <span className="font-medium text-ink">Add to Home Screen</span>, and turn them on from there.
        </p>
      ) : a.state === "host-disabled" ? (
        <p className="text-sm text-ink-2">{a.reason}</p>
      ) : a.state === "denied" ? (
        <p className="text-sm text-ink-2">
          Notifications are blocked for this site. Allow them in{" "}
          {env.platform === "ios" ? `Settings › Notifications › ${PRODUCT_NAME}` : env.platform === "android" ? "the site settings behind the lock icon" : "your browser’s site settings"}, then come back.
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-2">
            {push.subscribed
              ? "A notification arrives when a session on the desktop is waiting for you. Tapping it opens the exact question."
              : "Get a notification when a session is waiting for you, even with the app closed."}
          </p>
          <div className="flex flex-wrap gap-2">
            {push.subscribed ? (
              <>
                <Button variant="outline" size="sm" disabled={push.busy} onClick={() => void push.test()}>
                  <Send aria-hidden="true" />
                  Send a test
                </Button>
                <Button variant="ghost" size="sm" disabled={push.busy} onClick={() => void push.disable()}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={push.busy} onClick={() => void push.enable()}>
                <BellRing aria-hidden="true" />
                {push.busy ? "Turning on…" : "Turn on"}
              </Button>
            )}
          </div>
        </>
      )}
      {push.error ? (
        <p role="alert" className="text-sm text-danger">
          {push.error}
        </p>
      ) : null}
    </section>
  );
}
