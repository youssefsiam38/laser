import { PRODUCT_NAME } from "@lasercode/protocol";
import { BellRing, Download, Maximize2, Share, Zap } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { promptInstall, useCanPromptInstall, type PwaEnvironment } from "@/pwa";
import { useLaserState } from "@/runtime";
import { FORTNIGHT_MS, INSTALL_KEY, useDismissed } from "./remembered.js";

/** After connecting, wait this long before suggesting the home screen. */
const APPEAR_AFTER_MS = 4_000;

/**
 * The first-run moment on a phone: why the home screen matters here
 * (on iPhone it is the only way to get notifications), and the exact taps.
 * Chromium gets the real install sheet; Safari gets its three steps. Shown
 * once, then not again for a fortnight; never when already installed or on an
 * insecure address, where it would be a promise the browser cannot keep.
 */
export function InstallPrompt({ env }: { env: PwaEnvironment }) {
  const [dismissed, dismiss] = useDismissed(INSTALL_KEY);
  const canPrompt = useCanPromptInstall();
  const connection = useLaserState((s) => s.connection);
  // Nothing has been done in the app yet: a sheet that says it "works best
  // installed" before the person has seen it work is the first thing they meet,
  // and it is an advert. It waits until there is a session to come back to.
  const used = useLaserState((s) => s.sessions.length > 0 || Object.keys(s.open).length > 0);
  const [open, setOpen] = useState(false);
  const eligible = env.secure && !env.standalone && env.touch && !dismissed && used;

  useEffect(() => {
    if (!eligible || connection !== "open") return;
    const t = setTimeout(() => setOpen(true), APPEAR_AFTER_MS);
    return () => clearTimeout(t);
  }, [eligible, connection]);

  if (!eligible) return null;

  const close = () => {
    setOpen(false);
    dismiss(FORTNIGHT_MS);
  };

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") dismiss();
    else close();
  };

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <SheetContent side="bottom" showCloseButton={false} className="gap-0 px-5 pt-3">
        <div className="mx-auto flex w-full max-w-[76ch] flex-col gap-5 pt-3 pb-4">
          <div className="flex flex-col gap-1.5">
            <p className="eyebrow">Add to Home Screen</p>
            <SheetTitle className="text-lg leading-lg">{PRODUCT_NAME} works best installed</SheetTitle>
            <SheetDescription className="text-sm text-ink-2">
              {env.platform === "ios"
                ? "On iPhone, notifications only work from the home screen — Safari itself cannot deliver them."
                : "Full-screen, no browser bars, and notifications when the agent needs you."}
            </SheetDescription>
          </div>

          <ul className="flex flex-col gap-2.5" aria-label="What you get">
            <Benefit icon={<BellRing />} title="Know when it needs you" body="A notification opens the exact approval, with Allow and Deny to hand." />
            <Benefit icon={<Maximize2 />} title="Full screen" body="The composer sits on the keyboard; nothing from the browser in the way." />
            <Benefit icon={<Zap />} title="Opens instantly" body="The app shell is saved on the phone; only your sessions come over the wire." />
          </ul>

          {env.platform === "ios" ? (
            <ol className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink" aria-label="Steps in Safari">
              <Step n={1}>
                Tap <Share aria-hidden="true" className="mx-0.5 inline size-4 align-[-3px] text-live" /> <span className="font-medium">Share</span> in Safari’s toolbar
              </Step>
              <Step n={2}>
                Choose <span className="font-medium">Add to Home Screen</span>
              </Step>
              <Step n={3}>
                Tap <span className="font-medium">Add</span>, then open {PRODUCT_NAME} from the home screen
              </Step>
            </ol>
          ) : !canPrompt ? (
            <p className="rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink-2">
              In your browser’s menu choose <span className="font-medium text-ink">Install app</span> or{" "}
              <span className="font-medium text-ink">Add to Home screen</span>.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button variant="outline" size="lg" className="h-12 flex-1 text-base" onClick={close}>
              Not now
            </Button>
            {canPrompt ? (
              <Button size="lg" className="h-12 flex-[1.6] text-base" onClick={() => void install()}>
                <Download aria-hidden="true" />
                Install
              </Button>
            ) : (
              <Button size="lg" className="h-12 flex-[1.6] text-base" onClick={close}>
                Got it
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Benefit({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-live [&>svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-base font-medium text-ink">{title}</span>
        <span className="text-sm text-ink-2">{body}</span>
      </span>
    </li>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="typed mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface text-ink-2 tnum">{n}</span>
      <span className="leading-base">{children}</span>
    </li>
  );
}
