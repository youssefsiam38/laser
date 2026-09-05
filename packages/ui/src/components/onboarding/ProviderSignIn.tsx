"use client";
/**
 * Signing in to one provider from inside the window (M10-T6). The worker runs
 * the agent's own login flow and every callback it would have shown in a
 * terminal arrives here as a `pi/providers/login/event`: a page to open, a
 * device code to type, a question to answer, progress, and the end. Nothing
 * about the credential itself ever crosses the wire back to this component.
 *
 * Failures are the `error-state` element with a Retry; waiting is the
 * `loading-state` element; a secret is typed into a password field and sent
 * once. Cancelling tells the worker so nothing is left pending.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, KeyRound } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import type { ProviderAuthInfo, ProviderLoginEvent, ProviderLoginMethod, ProviderLoginPrompt } from "@piorbit/protocol";

export interface ProviderSignInProps {
  cwd: string;
  provider: ProviderAuthInfo;
  method: ProviderLoginMethod;
  onDone: () => void;
  onCancel: () => void;
  className?: string | undefined;
}

type Status = "starting" | "waiting" | "done" | "error" | "cancelled";

interface Flow {
  id: string | undefined;
  status: Status;
  error: string | undefined;
  url: string | undefined;
  instructions: string | undefined;
  device: { userCode: string; verificationUri: string; expiresInSeconds?: number | undefined } | undefined;
  info: Array<{ message: string; links?: Array<{ url: string; label?: string }> | undefined }>;
  progress: string | undefined;
  prompt: ProviderLoginPrompt | undefined;
}

const fresh = (): Flow => ({
  id: undefined,
  status: "starting",
  error: undefined,
  url: undefined,
  instructions: undefined,
  device: undefined,
  info: [],
  progress: undefined,
  prompt: undefined,
});

export function ProviderSignIn({ cwd, provider, method, onDone, onCancel, className }: ProviderSignInProps) {
  const { client } = usePiorbitStable();
  const [flow, setFlow] = useState<Flow>(fresh);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  /** Events that arrived before `start` answered with the id. */
  const early = useRef<Array<{ id: string; event: ProviderLoginEvent }>>([]);
  const doneRef = useRef(false);
  const copy = useCopy();

  const apply = useCallback((event: ProviderLoginEvent) => {
    setFlow((current) => {
      switch (event.type) {
        case "auth_url":
          return { ...current, status: "waiting", url: event.url, instructions: event.instructions, progress: undefined };
        case "device_code":
          return {
            ...current,
            status: "waiting",
            device: { userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds },
            progress: undefined,
          };
        case "info":
          return { ...current, status: "waiting", info: [...current.info, { message: event.message, links: event.links }] };
        case "progress":
          return { ...current, status: "waiting", progress: event.message };
        case "prompt":
          return { ...current, status: "waiting", prompt: event.prompt, progress: undefined };
        case "done":
          return { ...current, status: "done", prompt: undefined, progress: undefined, error: undefined };
        case "error":
          return { ...current, status: "error", error: event.message, prompt: undefined, progress: undefined };
        case "cancelled":
          return { ...current, status: "cancelled", prompt: undefined, progress: undefined };
      }
    });
  }, []);

  // Subscribe before starting so a prompt the worker emits before it answers
  // `start` is not lost; it is parked until the id is known.
  useEffect(
    () =>
      client.subscribe((notificationMethod, params) => {
        if (notificationMethod !== "pi/providers/login/event") return;
        const { id, event, provider: providerId, cwd: eventCwd } = params as { cwd: string; id: string; provider: string; event: ProviderLoginEvent };
        if (eventCwd !== cwd || providerId !== provider.id) return;
        const mine = flowRef.current.id;
        if (mine === undefined) {
          early.current.push({ id, event });
          return;
        }
        if (id === mine) apply(event);
      }),
    [apply, client, cwd, provider.id],
  );

  const start = useCallback(async () => {
    setFlow(fresh());
    setAnswer("");
    early.current = [];
    doneRef.current = false;
    try {
      const { id } = await client.request("pi/providers/login/start", { cwd, provider: provider.id, method });
      setFlow((current) => ({ ...current, id, status: current.status === "starting" ? "waiting" : current.status }));
      for (const parked of early.current) if (parked.id === id) apply(parked.event);
      early.current = [];
    } catch (startError) {
      setFlow((current) => ({ ...current, status: "error", error: startError instanceof Error ? startError.message : String(startError) }));
    }
  }, [apply, client, cwd, method, provider.id]);

  useEffect(() => {
    void start();
    // Only on mount and when the provider or method changes; `start` is stable for those.
  }, [start]);

  useEffect(() => {
    if (flow.status === "done" && !doneRef.current) {
      doneRef.current = true;
      const handle = setTimeout(onDone, 900);
      return () => clearTimeout(handle);
    }
    return undefined;
  }, [flow.status, onDone]);

  const cancel = useCallback(() => {
    const id = flowRef.current.id;
    if (id && flowRef.current.status === "waiting") void client.request("pi/providers/login/cancel", { cwd, id }).catch(() => undefined);
    onCancel();
  }, [client, cwd, onCancel]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = flow.prompt;
    if (!prompt || !flow.id) return;
    const value = answer.trim();
    if (value === "" && prompt.kind !== "select") return;
    setSending(true);
    try {
      await client.request("pi/providers/login/answer", { cwd, id: flow.id, promptId: prompt.id, value });
      setAnswer("");
      setFlow((current) => (current.prompt?.id === prompt.id ? { ...current, prompt: undefined, progress: "Checking…" } : current));
    } catch (answerError) {
      setFlow((current) => ({ ...current, status: "error", error: answerError instanceof Error ? answerError.message : String(answerError) }));
    } finally {
      setSending(false);
    }
  };

  const choose = async (optionId: string) => {
    const prompt = flow.prompt;
    if (!prompt || !flow.id) return;
    setSending(true);
    try {
      await client.request("pi/providers/login/answer", { cwd, id: flow.id, promptId: prompt.id, value: optionId });
      setFlow((current) => (current.prompt?.id === prompt.id ? { ...current, prompt: undefined, progress: "Checking…" } : current));
    } catch (answerError) {
      setFlow((current) => ({ ...current, status: "error", error: answerError instanceof Error ? answerError.message : String(answerError) }));
    } finally {
      setSending(false);
    }
  };

  const methodLabel = method === "oauth" ? (provider.oauthLabel ?? "Sign in with your account") : "Use an API key";

  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3", className)} aria-live="polite">
      <div className="flex items-center gap-2">
        <KeyRound aria-hidden="true" className="size-4 text-ink-3" />
        <p className="text-sm font-medium text-ink">
          {provider.name} · {methodLabel}
        </p>
      </div>

      {flow.status === "starting" && <GenerationLoader label="Starting sign-in" layout="inline" />}

      {flow.info.map((entry, i) => (
        <p key={`${i}-${entry.message}`} className="text-sm leading-sm text-ink-2">
          {entry.message}
          {entry.links?.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener" className="ms-1 text-live underline-offset-4 hover:underline">
              {link.label ?? link.url}
            </a>
          ))}
        </p>
      ))}

      {flow.url && flow.status === "waiting" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-sm text-ink-2">{flow.instructions ?? "Sign in on the page that opens, then come back here."}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <a href={flow.url} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> Open the sign-in page
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void copy.copy(flow.url ?? "")} aria-label="Copy the sign-in link">
              {copy.copied ? <Check /> : <Copy />} {copy.copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      )}

      {flow.device && flow.status === "waiting" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-sm text-ink-2">Enter this code on the provider’s page.</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="typed rounded-lg bg-surface px-3 py-1.5 text-lg tracking-wider text-ink select-all">{flow.device.userCode}</span>
            <Button variant="ghost" size="sm" onClick={() => void copy.copy(flow.device?.userCode ?? "")} aria-label="Copy the code">
              {copy.copied ? <Check /> : <Copy />} {copy.copied ? "Copied" : "Copy"}
            </Button>
            <Button asChild size="sm">
              <a href={flow.device.verificationUri} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> Open the page
              </a>
            </Button>
          </div>
          {flow.device.expiresInSeconds !== undefined && (
            <p className="tnum text-xs text-ink-3">The code is good for about {Math.max(1, Math.round(flow.device.expiresInSeconds / 60))} minutes.</p>
          )}
        </div>
      )}

      {flow.prompt && flow.status === "waiting" && (
        <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
          <label className="text-sm leading-sm text-ink-2" htmlFor={`login-prompt-${flow.prompt.id}`}>
            {flow.prompt.message}
          </label>
          {flow.prompt.kind === "select" ? (
            <div className="flex flex-col gap-1" role="group" aria-label={flow.prompt.message}>
              {(flow.prompt.options ?? []).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={sending}
                  onClick={() => void choose(option.id)}
                  className={cn(
                    "flex flex-col items-start rounded-lg border border-line bg-surface px-3 py-2 text-start outline-none",
                    "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))] hover:bg-surface-2",
                    "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live disabled:opacity-45",
                  )}
                >
                  <span className="text-sm font-medium text-ink">{option.label}</span>
                  {option.description && <span className="text-xs leading-4 text-ink-2">{option.description}</span>}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`login-prompt-${flow.prompt.id}`}
                type={flow.prompt.kind === "secret" ? "password" : "text"}
                autoComplete={flow.prompt.kind === "secret" ? "off" : undefined}
                autoFocus
                spellCheck={false}
                value={answer}
                placeholder={flow.prompt.placeholder ?? (flow.prompt.kind === "manual_code" ? "Paste the code here" : undefined)}
                onChange={(event) => setAnswer(event.target.value)}
                className="min-w-48 flex-1 font-mono"
              />
              <Button type="submit" size="sm" disabled={sending || answer.trim() === ""}>
                Continue
              </Button>
            </div>
          )}
          {flow.prompt.kind === "secret" && (
            <p className="text-xs leading-4 text-ink-3">
              Stored on this computer, by the agent, in the same place it keeps its other credentials. It is never sent anywhere except to the provider
              itself, and {PRODUCT_NAME} never shows it again.
            </p>
          )}
        </form>
      )}

      {flow.progress && flow.status === "waiting" && <GenerationLoader label={flow.progress} layout="inline" />}

      {flow.status === "waiting" && !flow.prompt && !flow.progress && (flow.url || flow.device) && (
        <GenerationLoader label="Waiting for the sign-in to finish" layout="inline" />
      )}

      {flow.status === "done" && (
        <p className="flex items-center gap-2 text-sm font-medium text-ok" role="status">
          <Check aria-hidden="true" className="size-4" /> Signed in to {provider.name}
        </p>
      )}

      {flow.status === "error" && <ErrorState title={`Could not sign in to ${provider.name}`} detail={flow.error} onRetry={() => void start()} retryLabel="Try again" />}

      {flow.status === "cancelled" && <p className="text-sm text-ink-2">Sign-in was cancelled.</p>}

      {flow.status !== "done" && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={cancel}>
            {flow.status === "waiting" || flow.status === "starting" ? "Cancel" : "Back"}
          </Button>
        </div>
      )}
    </div>
  );
}
