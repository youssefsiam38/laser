"use client";
/**
 * Sign-in (docs/mcp.md "Sign-in"): the browser opens, the app waits, and the
 * row turns connected on its own through `mcp/changed`. When the browser
 * cannot reach the app — a phone, a remote machine — the same dialog takes
 * the callback address or the code by hand, so the flow never dead-ends.
 */
import type { McpAuthStart, McpScope } from "@lasercode/protocol";
import { Check, Copy, ExternalLink, LogOut } from "lucide-react";
import { useEffect, useState } from "react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCopy } from "@/hooks/use-copy";
import { useLaserStable } from "@/runtime";

export function McpSignInDialog({
  cwd,
  target,
  onOpenChange,
  onDone,
}: {
  cwd: string;
  /** The server being signed in to; `undefined` closes the dialog. */
  target: { scope: McpScope; name: string; title: string } | undefined;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { client } = useLaserStable();
  const [start, setStart] = useState<McpAuthStart>();
  const [starting, setStarting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const copy = useCopy();

  useEffect(() => {
    if (!target) return;
    setStart(undefined);
    setPasted("");
    setError(undefined);
    setDone(false);
    setStarting(true);
    let cancelled = false;
    void client
      .request("mcp/auth/start", { cwd, scope: target.scope, name: target.name })
      .then((result) => {
        if (!cancelled) setStart(result);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, cwd, target]);

  const complete = async () => {
    if (!target || !pasted.trim()) return;
    setCompleting(true);
    setError(undefined);
    const value = pasted.trim();
    try {
      const result = await client.request("mcp/auth/complete", {
        cwd,
        scope: target.scope,
        name: target.name,
        ...(/^https?:\/\//i.test(value) ? { redirectUrl: value } : { code: value }),
      });
      if (result.status === "needs-auth") {
        setError(result.detail ?? "That did not complete the sign-in. Try the link again.");
        return;
      }
      setDone(true);
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setCompleting(false);
    }
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent data-slot="mcp-sign-in-dialog" className="sm:max-w-120">
        <DialogHeader>
          <DialogTitle>Sign in to {target?.title ?? "the server"}</DialogTitle>
          <DialogDescription>It opens in your browser. Come back here when it is finished.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {starting && <GenerationLoader label="Preparing the sign-in" layout="inline" />}
          {start && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm">
                  <a href={start.authorizationUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink aria-hidden="true" /> Open the sign-in page
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Copy the sign-in link"
                  onClick={() => void copy.copy(start.authorizationUrl)}
                >
                  {copy.copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copy.copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <p className="typed break-all text-ink-3">{start.authorizationUrl}</p>
              {start.callbackListening ? (
                <GenerationLoader label="Waiting for the browser to finish" layout="inline" />
              ) : (
                <p className="text-sm leading-6 text-ink-2">
                  {start.manualHint ?? "When it is done, copy the address it lands on and paste it below."}
                </p>
              )}
              <label className="flex flex-col gap-1 text-sm text-ink">
                Paste the address it lands on, or the code
                <Input
                  value={pasted}
                  placeholder="https://localhost/callback?code=…"
                  spellCheck={false}
                  onChange={(event) => setPasted(event.target.value)}
                />
              </label>
            </>
          )}
          {done && (
            <p role="status" className="text-sm text-live">
              Signed in.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm leading-6 text-danger">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {done ? "Close" : "Not now"}
          </Button>
          <Button type="button" disabled={!pasted.trim() || completing} onClick={() => void complete()}>
            Finish sign-in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function McpSignOutDialog({
  cwd,
  target,
  onOpenChange,
  onDone,
}: {
  cwd: string;
  target: { scope: McpScope; name: string; title: string } | undefined;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { client } = useLaserStable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const signOut = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request("mcp/auth/logout", { cwd, scope: target.scope, name: target.name });
      onDone();
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent data-slot="mcp-sign-out-dialog" className="sm:max-w-100">
        <DialogHeader>
          <DialogTitle>Sign out of {target?.title ?? "the server"}?</DialogTitle>
          <DialogDescription>
            The saved sign-in is forgotten. The server stays configured, and you can sign in again whenever you want.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm leading-6 text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Keep me signed in
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void signOut()}>
            <LogOut aria-hidden="true" /> Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
