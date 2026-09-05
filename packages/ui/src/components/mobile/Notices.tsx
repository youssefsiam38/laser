import { PRODUCT_NAME } from "@lasercode/protocol";
import { BellRing, ChevronDown, RotateCw, ShieldOff, Sparkles, WifiOff, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { applyUpdate, asRawClient, insecureOriginAdvice, useEnvironment, usePush, useServiceWorker, type PwaEnvironment } from "@/pwa";
import { usePiorbitStable, usePiorbitState, usePiorbitView } from "@/runtime";
import { StackRow } from "./MobileStack.js";
import { INSECURE_KEY, NOTIFY_HINT_KEY, useDismissed } from "./remembered.js";

/**
 * The phone opened `http://192.168.…` — a LAN address is not a secure
 * context, so installing, notifications, the microphone and offline use are
 * off. Said once, in words, with the fix; dismissible per origin.
 */
export function InsecureOriginNotice({ env }: { env: PwaEnvironment }) {
  const [dismissed, dismiss] = useDismissed(INSECURE_KEY(env.origin));
  const [open, setOpen] = useState(false);
  if (env.secure || dismissed) return null;
  const advice = insecureOriginAdvice(env);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <StackRow tone="attention" role="status" className={cn("flex-col items-stretch gap-0 px-0", open && "pb-3")}>
        <div className="flex min-h-9 items-center gap-2 px-3">
          <ShieldOff aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
          <span className="min-w-0 flex-1 truncate font-medium">{advice.title}</span>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" className="-me-1 text-ink-2" aria-expanded={open}>
              {open ? "Less" : "Why?"}
              <ChevronDown aria-hidden="true" className={cn("transition-transform duration-(--motion-slow)", open && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <TooltipIconButton tooltip="Dismiss for this address" size="icon-xs" side="top" className="-me-2 text-ink-3" onClick={() => dismiss()}>
            <X />
          </TooltipIconButton>
        </div>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-3 pt-1">
            <p className="text-sm text-ink-2">{advice.body}</p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Not available here">
              {advice.missing.map((m) => (
                <li key={m} className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-3 line-through decoration-ink-3/60">
                  {m}
                </li>
              ))}
            </ul>
            <ol className="flex flex-col gap-1.5 text-sm text-ink">
              {advice.steps.map((step, i) => (
                <li key={step} className="flex gap-2">
                  <span className="typed mt-0.5 shrink-0 text-ink-3">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </CollapsibleContent>
      </StackRow>
    </Collapsible>
  );
}

/** The network is gone (distinct from the host being unreachable, which the shell's banner covers). */
export function OfflineNotice({ env }: { env: PwaEnvironment }) {
  if (env.online) return null;
  return (
    <StackRow tone="danger" role="status">
      <WifiOff aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
      <span className="min-w-0 flex-1 truncate font-medium">You’re offline</span>
      <span className="hidden truncate text-ink-3 min-[420px]:inline">Reconnects when the network returns</span>
    </StackRow>
  );
}

/** A newer build is installed and waiting. Never swaps under the user's feet. */
export function UpdateReady() {
  const sw = useServiceWorker();
  if (!sw.updateReady) return null;
  return (
    <StackRow tone="live" role="status">
      <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-live" />
      <span className="min-w-0 flex-1 truncate font-medium">A new version of {PRODUCT_NAME} is ready</span>
      <Button size="xs" variant="secondary" className="-me-1" onClick={applyUpdate}>
        <RotateCw aria-hidden="true" />
        Reload
      </Button>
    </StackRow>
  );
}

/**
 * The moment someone answers a question on their phone is the moment
 * notifications become worth having. One row, once, and only when they would
 * actually work — the offer is dismissed for good either way.
 */
export function NotifyHint() {
  const { client } = usePiorbitStable();
  const env = useEnvironment();
  const push = usePush(asRawClient(client), env);
  const [dismissed, dismiss] = useDismissed(NOTIFY_HINT_KEY);
  const connection = usePiorbitState((s) => s.connection);
  const waiting = usePiorbitView()?.dialogs.length ?? 0;
  if (dismissed || waiting === 0 || connection !== "open") return null;
  if (push.availability.state !== "ready" || push.subscribed) return null;
  return (
    <StackRow tone="live">
      <BellRing aria-hidden="true" className="size-3.5 shrink-0 text-live" />
      <span className="min-w-0 flex-1 truncate">Get a notification next time the agent needs you.</span>
      <Button size="xs" variant="secondary" disabled={push.busy} onClick={() => void push.enable().then(() => dismiss())}>
        Turn on
      </Button>
      <Button size="xs" variant="ghost" className="text-ink-3" onClick={() => dismiss()}>
        Not now
      </Button>
    </StackRow>
  );
}
