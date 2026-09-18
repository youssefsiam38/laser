"use client";
/**
 * Sign-in (docs/mcp.md "Sign-in"): the browser opens, the app waits, and the
 * row turns connected on its own through `mcp/changed`. When the browser
 * cannot reach the app — a phone, a remote machine — the same dialog takes
 * the callback address or the code by hand, so the flow never dead-ends.
 */
import type { ClientRequests, McpAuthStart, McpScope } from "@lasercode/protocol";
import { Check, Copy, ExternalLink, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCopy } from "@/hooks/use-copy";
import { useLaserStable } from "@/runtime";
import type { ScopeDraft } from "../ScopeDraftGuard.js";
import { useCommittedTargetLifetime } from "../useCommittedTargetLifetime.js";

/** Long enough to read “Signed in.”, short enough not to be in the way. */
const SIGNED_IN_LINGER_MS = 1200;

export function McpSignInDialog({
  cwd,
  target,
  onOpenChange,
  onDone,
  view,
  onDraftChange,
}: {
  cwd: string;
  /** The server being signed in to; `undefined` closes the dialog. */
  target: { scope: McpScope; name: string; title: string } | undefined;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  view: ClientRequests["mcp/list"]["params"]["view"];
  onDraftChange?: ((draft: ScopeDraft | undefined) => void) | undefined;
}) {
  const { client } = useLaserStable();
  const [start, setStart] = useState<McpAuthStart>();
  const [starting, setStarting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const copy = useCopy();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lifetime = useCommittedTargetLifetime(`${cwd}:${target?.scope ?? "closed"}:${target?.name ?? ""}:oauth`);

  const finish = useCallback(() => {
    const lease = lifetime.capture();
    if (!lease) return;
    setDone(true);
    onDone();
    // Say it worked, then get out of the way: nobody should have to dismiss a
    // sign-in that already finished.
    closeTimer.current = setTimeout(() => {
      if (lifetime.isCurrent(lease)) onOpenChange(false);
    }, SIGNED_IN_LINGER_MS);
  }, [lifetime, onDone, onOpenChange]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!target) return;
    const lease = lifetime.capture();
    if (!lease) return;
    setStart(undefined);
    setPasted("");
    setError(undefined);
    setDone(false);
    setStarting(true);
    let cancelled = false;
    void client
      .request("mcp/auth/start", { cwd, scope: target.scope, name: target.name })
      .then((result) => {
        if (!cancelled && lifetime.isCurrent(lease)) setStart(result);
      })
      .catch((failure: unknown) => {
        if (!cancelled && lifetime.isCurrent(lease)) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!cancelled && lifetime.isCurrent(lease)) setStarting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, cwd, lifetime, target]);

  /**
   * The browser finishes on its own: the worker writes the credential and
   * says `mcp/changed`. Without this the dialog sat on "Waiting for the
   * browser" over a row that had already turned connected.
   */
  useEffect(() => {
    if (!target || done) return;
    return client.subscribe((method, params) => {
      if (method !== "mcp/changed" || (params as { cwd: string }).cwd !== cwd) return;
      const lease = lifetime.capture();
      if (!lease) return;
      void client
        .request("mcp/list", { cwd, view })
        .then(({ servers }) => {
          if (!lifetime.isCurrent(lease)) return;
          const server = servers.find((entry) => entry.scope === target.scope && entry.config.name === target.name);
          if (server && server.status !== "needs-auth") finish();
        })
        .catch(() => {
          // The list is re-read by the page as well; a failure here is not
          // the person's problem.
        });
    });
  }, [client, cwd, target, done, finish, lifetime, view]);

  const complete = async (): Promise<boolean> => {
    if (!target || !pasted.trim()) return false;
    const lease = lifetime.capture();
    if (!lease) return false;
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
      if (!lifetime.isCurrent(lease)) return false;
      if (result.status === "needs-auth") {
        setError(result.detail ?? "That did not complete the sign-in. Try the link again.");
        return false;
      }
      finish();
      return true;
    } catch (failure) {
      if (lifetime.isCurrent(lease)) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (lifetime.isCurrent(lease)) setCompleting(false);
    }
  };

  useEffect(() => {
    if (!target || done || !lifetime.capture()) {
      onDraftChange?.(undefined);
      return;
    }
    onDraftChange?.({
      id: "mcp-sign-in",
      label: `${target.title} sign-in`,
      ...(pasted.trim() ? { save: complete } : {}),
      discard: () => onOpenChange(false),
    });
    return () => onDraftChange?.(undefined);
  }, [done, lifetime, onDraftChange, pasted, target]);

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent data-slot="mcp-sign-in-dialog" className="sm:max-w-120">
        <DialogHeader>
          <DialogTitle>Sign in to {target?.title ?? "the server"}</DialogTitle>
          <DialogDescription>It opens in your browser. Come back here when it is finished.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {starting && <GenerationLoader label="Preparing the sign-in" layout="inline" />}
          {start && !done && (
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
            <p data-slot="mcp-signed-in" role="status" className="text-sm text-live">
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
  const lifetime = useCommittedTargetLifetime(`${cwd}:${target?.scope ?? "closed"}:${target?.name ?? ""}:sign-out`);

  const signOut = async () => {
    if (!target) return;
    const lease = lifetime.capture();
    if (!lease) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request("mcp/auth/logout", { cwd, scope: target.scope, name: target.name });
      if (!lifetime.isCurrent(lease)) return;
      onDone();
      onOpenChange(false);
    } catch (failure) {
      if (lifetime.isCurrent(lease)) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (lifetime.isCurrent(lease)) setBusy(false);
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
