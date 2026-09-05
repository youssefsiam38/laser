import { PRODUCT_NAME } from "@lasercode/protocol";
import { useEffect, useState } from "react";
import { ShieldQuestionMark } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useTrustPrompts } from "@/runtime";

/**
 * Pi's project-trust question, asked by the host before it starts a worker
 * (M2-T4). Pi's own SDK never asks — it defaults to trusting — so this dialog
 * is the only thing standing between a cloned repository and its `.pi`
 * extensions running on this machine. It is modal on purpose: a worker start is
 * blocked behind the answer, and there is no safe default to pick silently.
 *
 * Why this is not the `permission-grant` element (docs/ux-elements.md claims
 * that element for this surface, and it is used for the in-thread case in
 * `panels/islands/bodies/DecisionBody.tsx`). Two things it cannot express, and
 * both of them matter more here than the shared drawing does:
 *
 *   1. It puts `data-autofocus` on its FIRST option — the granting one. On
 *      this prompt focus must sit on the safe answer, because Enter on a
 *      security question must never be the keystroke that grants. Adopting it
 *      here would be a real regression, not a restyle.
 *   2. Its `message` is a single string. This question is not answerable
 *      without seeing the directory it is about and which files in it are
 *      trust-gated, so the body needs the path and the reason chips below.
 *
 * Everything else follows the element: the same eyebrow → title → message
 * order, the same "this grants" idea spelled out on the Remember control.
 */
export function TrustDialog() {
  const { requests, answer } = useTrustPrompts();
  const request = requests[0];
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  // Each question is its own decision; do not carry the last checkbox over.
  useEffect(() => {
    setRemember(true);
    setBusy(false);
  }, [request?.id]);

  if (!request) return null;

  /** `remember` is deliberately ignored for a dismissal; see `dismiss`. */
  const decide = (trusted: boolean, persist = remember) => {
    setBusy(true);
    void answer(request.cwd, trusted, persist);
  };

  /**
   * Escape and a backdrop click mean "not now", never "declined, forever". Esc
   * closes every other overlay in the app, and recording a permanent decline
   * from a reflex would leave the project read-only with `piorbit projects
   * trust` as the only way back.
   */
  const dismiss = () => decide(false, false);

  return (
    <Dialog open onOpenChange={dismiss}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestionMark className="size-4 text-attention" aria-hidden="true" />
            Trust {shortCwd(request.cwd)}?
          </DialogTitle>
          <DialogDescription>
            This directory ships its own agent configuration. Trusting it lets the agent load and run these files,
            with your permissions, in every session you start here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
            <p className="font-mono text-xs break-all text-ink-2">{request.cwd}</p>
            <ul role="list" className="mt-1.5 flex flex-wrap gap-1.5">
              {request.reasons.map((reason) => (
                <li key={reason} className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-xs text-ink">
                  {reason}
                </li>
              ))}
            </ul>
          </div>

          <label className="flex items-start gap-2.5 text-sm leading-5 text-ink-2">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className={cn(
                "mt-0.5 size-4 shrink-0 rounded-sm border border-line accent-[var(--live)]",
                "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
              )}
            />
            <span>
              Remember this decision for this directory.
              <span className="block text-xs text-ink-3">
                Stored by {PRODUCT_NAME}, and only by {PRODUCT_NAME}. The agent&rsquo;s own trust list is left alone.
              </span>
            </span>
          </label>

          <p className="text-xs leading-4 text-ink-3">
            Not now keeps the session working: the agent simply ignores this directory&rsquo;s settings, extensions,
            skills and prompts.
          </p>
        </div>

        <DialogFooter>
          {/* Focus sits on the safe answer: Enter on a security prompt must not
              be the one that grants. */}
          <Button type="button" variant="ghost" autoFocus disabled={busy} onClick={() => decide(false)}>
            Not now
          </Button>
          <Button type="button" disabled={busy} onClick={() => decide(true)}>
            Trust this project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
