"use client";
/**
 * Step: connect a model provider. The list is the agent's own, with whether a
 * credential resolves right now (M4-T4's `pi/providers/list`), sorted with the
 * signed-in ones first and the familiar ones next. Picking one offers the ways
 * it can be signed in to — an account, an API key, or both — and then hands
 * over to `ProviderSignIn`. A provider that says it supports neither is shown
 * without a verb, with the reason where the verb would be (R2).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, KeyRound, LogOut, UserRound } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import type { ProviderAuthInfo, ProviderLoginMethod } from "@piorbit/protocol";

import { ProviderSignIn } from "./ProviderSignIn.js";
import { sortProviders } from "./setup-model.js";

export interface ProviderStepProps {
  cwd: string;
  /** Called whenever the configured set changes, with how many are signed in. */
  onConfigured: (count: number) => void;
  /**
   * True while a sign-in is on screen. The sign-in has its own Continue — the
   * one that submits a code or a key — and the card's footer must not put a
   * second, near-identical Continue two centimetres away from it.
   */
  onBusyChange?: ((busy: boolean) => void) | undefined;
}

/** Above this many, a filter box appears; below it, the list is short enough to read. */
const FILTER_THRESHOLD = 8;

export function ProviderStep({ cwd, onConfigured, onBusyChange }: ProviderStepProps) {
  const { client } = usePiorbitStable();
  const [providers, setProviders] = useState<ProviderAuthInfo[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [method, setMethod] = useState<ProviderLoginMethod>();
  const [filter, setFilter] = useState("");
  const [signingOut, setSigningOut] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const { providers: list } = await client.request("pi/providers/list", { cwd });
      setProviders(list);
      onConfigured(list.filter((p) => p.configured).length);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [client, cwd, onConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = providers?.find((p) => p.id === selected);
  const signingIn = current !== undefined && method !== undefined;
  useEffect(() => {
    onBusyChange?.(signingIn);
  }, [onBusyChange, signingIn]);

  const sorted = useMemo(() => sortProviders(providers ?? []), [providers]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === "" ? sorted : sorted.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(needle));
  }, [sorted, filter]);

  const signOut = async (provider: ProviderAuthInfo) => {
    setSigningOut(provider.id);
    try {
      const { providers: list } = await client.request("pi/providers/logout", { cwd, provider: provider.id });
      setProviders(list);
      onConfigured(list.filter((p) => p.configured).length);
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : String(logoutError));
    } finally {
      setSigningOut(undefined);
    }
  };

  if (error && !providers) {
    return <ErrorState title="Could not load the list of providers" detail={error} onRetry={() => void load()} retryLabel="Try again" />;
  }
  if (!providers) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-line px-3 py-8">
        <GenerationLoader label="Loading providers" layout="inline" />
      </div>
    );
  }

  // Signing in to the chosen provider takes the whole step.
  if (current && method) {
    return (
      <ProviderSignIn
        cwd={cwd}
        provider={current}
        method={method}
        onDone={() => {
          setMethod(undefined);
          setSelected(undefined);
          void load();
        }}
        onCancel={() => setMethod(undefined)}
      />
    );
  }

  // The chosen provider: which way in.
  if (current) {
    const methods = methodsOf(current);
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3">
        <div className="flex items-center gap-2">
          <ProviderLogo provider={current.id} className="size-5" />
          <p className="text-sm font-medium text-ink">{current.name}</p>
          {current.configured && (
            <Badge variant="ok" className="gap-1">
              <Check /> signed in
            </Badge>
          )}
        </div>
        {methods.length === 0 ? (
          <p className="text-sm leading-sm text-ink-2">
            {current.name} takes its credential from your environment rather than a sign-in, so there is nothing to do here.
            {current.configured ? " It is already available." : " Set it up on this computer and it will appear as signed in."}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5" role="group" aria-label={`How to sign in to ${current.name}`}>
            {methods.includes("oauth") && (
              <MethodButton
                icon={<UserRound />}
                title={current.oauthLabel ?? "Sign in with your account"}
                detail="Opens the provider’s sign-in page. A subscription or account is used directly."
                onClick={() => setMethod("oauth")}
              />
            )}
            {methods.includes("api_key") && (
              <MethodButton
                icon={<KeyRound />}
                title="Use an API key"
                detail="Paste a key from the provider’s console. It is kept on this computer."
                onClick={() => setMethod("api_key")}
              />
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSelected(undefined)}>
            Back to the list
          </Button>
          {current.configured && (
            <Button variant="destructive-ghost" size="sm" disabled={signingOut === current.id} onClick={() => void signOut(current)}>
              <LogOut /> Sign out
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sorted.length > FILTER_THRESHOLD && (
        <Input type="search" aria-label="Filter providers" placeholder="Filter providers" value={filter} onChange={(event) => setFilter(event.target.value)} />
      )}
      {error && <ErrorState title="Something went wrong" detail={error} />}
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto pe-0.5" aria-label="Providers">
        {shown.map((provider) => (
          <li key={provider.id}>
            <button
              type="button"
              onClick={() => setSelected(provider.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-start outline-none",
                "transition-[background-color,border-color] duration-(--motion-instant) motion-reduce:transition-none",
                "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))] hover:bg-surface-2",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
              )}
            >
              <ProviderLogo provider={provider.id} className="size-5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-ink">{provider.name}</span>
                  {provider.configured && (
                    <Badge variant="ok" className="gap-1">
                      <Check /> signed in
                    </Badge>
                  )}
                </span>
                <span className="block truncate text-xs leading-4 text-ink-3">
                  {provider.configured
                    ? provider.label ?? (provider.oauth ? "account" : "API key")
                    : provider.modelCount > 0
                      ? `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`
                      : "models appear after sign-in"}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-ink-2">No provider matches “{filter.trim()}”.</li>}
      </ul>
    </div>
  );
}

/** The ways in, as the worker reports them; both when it predates the report. */
function methodsOf(provider: ProviderAuthInfo): ProviderLoginMethod[] {
  if (provider.methods) return provider.methods;
  return ["oauth", "api_key"];
}

function MethodButton({ icon, title, detail, onClick }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-start outline-none",
        "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))] hover:bg-surface-2",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs leading-4 text-ink-2">{detail}</span>
      </span>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}
