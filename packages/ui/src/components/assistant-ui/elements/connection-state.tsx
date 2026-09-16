"use client";
/**
 * Connection state — the reconnecting banner (docs/ux-elements.md "Thread").
 * Installed from `elements-connection-state` and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - A full-width line under the top bar, not a floating card: it is the
 *     only thing in the shell that says "connection", and it sits where the
 *     eye already is.
 *   - Copy written for this product: the host, not "the server"; sessions
 *     resume from where they left off because the host replays them.
 *   - `resumedTokens` is gone: nothing counts tokens across a reconnect.
 *   - `HostConnectionState` is the runtime-bound wrapper; it derives the four
 *     phases from the socket state and holds "resumed" for a moment.
 */
import { CheckIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from "@lasercode/protocol";
import { refreshFrontend } from "@/pwa/register";
import { clearBrowserStorage } from "@/runtime/device-storage";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";

import { mono } from "./surfaces.js";

export type ConnectionPhase = "online" | "dropped" | "reconnecting" | "resumed";

export interface ConnectionStateProps extends Omit<ComponentProps<"div">, "children"> {
  phase: ConnectionPhase;
  /** Reconnect attempt number, when known. */
  attempt?: number | undefined;
  /** True the first time: nothing has connected yet, so nothing was lost. */
  first?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}

export function ConnectionState({ phase, attempt, first = false, onRetry, className, ...props }: ConnectionStateProps) {
  if (phase === "online") return null;
  const tone = phase === "dropped" ? "attention" : phase === "resumed" ? "ok" : "attention";
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="connection-state"
      data-phase={phase}
      className={cn(
        // One quiet line, until it carries an action: a 44px target cannot fit
        // in 32px, so the line grows for a coarse pointer rather than clipping
        // the only control on it. Only the phase that has the action grows.
        "flex min-h-8 shrink-0 items-center gap-2 px-4 text-xs hairline-b",
        phase === "dropped" && onRetry ? "pointer-coarse:min-h-14 pointer-coarse:py-1.5" : undefined,
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--motion-slow)",
        tone === "ok"
          ? "bg-[color-mix(in_oklab,var(--ok)_9%,var(--bg))]"
          : "bg-[color-mix(in_oklab,var(--attention)_9%,var(--bg))]",
        className,
      )}
      {...props}
    >
      {phase === "dropped" && (
        <>
          <CloudOffIcon aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
          <span className="font-medium text-ink">Disconnected from the host</span>
          <span className="hidden min-w-0 flex-1 truncate text-ink-2 sm:inline">
            Retrying in the background. Every session is saved on this computer as it goes, so nothing you have already seen is lost.
          </span>
          {onRetry && (
            <Button variant="outline" size="xs" onClick={onRetry} className="ms-auto shrink-0 pointer-coarse:min-h-11">
              Reconnect now
            </Button>
          )}
        </>
      )}
      {phase === "reconnecting" && (
        <>
          <StatusDot status="working" size="sm" label="Connecting" />
          <span className="font-medium text-ink">{first ? "Connecting to the host…" : "Reconnecting to the host…"}</span>
          <span className="hidden min-w-0 flex-1 truncate text-ink-2 sm:inline">
            {first ? "The desktop host serves this page and runs the agent." : "Sessions resume from where they left off."}
          </span>
          {attempt !== undefined && attempt > 1 && (
            <span className={cn(mono, "ms-auto shrink-0 text-ink-3")}>attempt {attempt}</span>
          )}
        </>
      )}
      {phase === "resumed" && (
        <>
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
          <span className="font-medium text-ink">Back online</span>
          <span className="hidden min-w-0 flex-1 truncate text-ink-2 sm:inline">Picked every session back up.</span>
        </>
      )}
    </div>
  );
}

/** How long "Back online" stays before the line goes away. */
const RESUMED_MS = 2500;

type UpdateNoticeState = {
  state: string;
  updateId?: string;
  version?: string;
  title?: string;
  message?: string;
  action?: "prepare" | "cancel" | "activate" | "retry" | "none";
  actionLabel?: string;
};

type DesktopUpdates = {
  version: string;
  updates: {
    status(): Promise<UpdateNoticeState>;
    prepare(): Promise<UpdateNoticeState>;
    cancel(): Promise<UpdateNoticeState>;
    install(): void;
    restart?(): void;
    onStatus(listener: (status: UpdateNoticeState) => void): () => void;
  };
};

function UpdateNoticeAction({ update, onRestart, onPrepare, onCancel }: {
  update: UpdateNoticeState;
  onRestart?: (() => void) | undefined;
  onPrepare?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}) {
  const props = { variant: "outline" as const, size: "sm" as const, className: "pointer-coarse:min-h-11" };
  switch (update.action) {
    case "prepare":
      return onPrepare ? <Button {...props} onClick={onPrepare}>{update.actionLabel}</Button> : null;
    case "cancel":
      return onCancel ? <Button {...props} onClick={onCancel}>{update.actionLabel}</Button> : null;
    case "activate":
    case "retry":
      return onRestart ? <Button {...props} onClick={onRestart}>{update.actionLabel}</Button> : null;
    default:
      return null;
  }
}

export function VersionNotice({ hostVersion, desktopVersion, update, onRefresh, onRestart, onPrepare, onCancel }: {
  hostVersion?: string; desktopVersion?: string; update?: UpdateNoticeState;
  onRefresh: () => void; onRestart?: () => void; onPrepare?: () => void; onCancel?: () => void;
}) {
  const local = desktopVersion !== undefined;
  const hostOlder = hostVersion !== undefined && hostVersion !== "unknown" &&
    hostVersion.localeCompare(PRODUCT_VERSION, undefined, { numeric: true }) < 0;
  const restart = local || hostOlder || hostVersion === "unknown";
  const fallbackTitle = restart ? `${PRODUCT_DISPLAY_NAME} is ready to restart` : "Refresh this view to continue";
  const fallbackDetail = restart
    ? "Restart the app and host together on the host computer when you are ready. Saved sessions are kept; active work will stop during restart."
    : "The host has been updated. This refresh only updates your frontend. Your sessions and running agents will not be affected.";
  let action = update
    ? <UpdateNoticeAction update={update} onRestart={onRestart} onPrepare={onPrepare} onCancel={onCancel} />
    : null;
  if (!update && restart && local && onRestart) {
    action = <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={onRestart}>Restart when ready…</Button>;
  } else if (!update && !restart) {
    action = <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={onRefresh}>Refresh view</Button>;
  }
  return (
    <div role="status" data-slot="version-notice" data-update-state={update?.state} className="relative z-110 flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 text-sm">
      <RefreshCwIcon aria-hidden="true" className="size-4 shrink-0 text-live" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium text-ink">{update?.title ?? fallbackTitle}</p>
        <p className="mt-1 text-xs text-ink-2">{update?.message ?? fallbackDetail}</p>
        <p className="mt-1 text-xs text-ink-3">{update?.version ? `Update ${update.version} · Running ${desktopVersion}` : `This view ${PRODUCT_VERSION} · Host ${hostVersion}`}</p>
      </div>
      {action}
    </div>
  );
}

/** Shared connection element; both native updates and remote version drift live here. */
export function HostVersionNotice() {
  const mismatch = useLaserState((s) => s.versionMismatch);
  const desktop = (globalThis as typeof globalThis & { desktop?: DesktopUpdates }).desktop;
  const [update, setUpdate] = useState<UpdateNoticeState>();
  useEffect(() => {
    if (!desktop?.updates) return;
    let active = true;
    const receive = (status: UpdateNoticeState) => {
      const visible = ["downloaded", "parking", "ready", "restarting", "failed"].includes(status.state);
      if (active) setUpdate(visible ? status : undefined);
    };
    void desktop.updates.status().then(receive).catch(() => {});
    const off = desktop.updates.onStatus(receive);
    return () => { active = false; off(); };
  }, [desktop]);
  if (!mismatch && !update) return null;
  return <VersionNotice {...(mismatch ? { hostVersion: mismatch } : {})}
    {...(desktop ? { desktopVersion: desktop.version } : {})}
    {...(update ? { update } : {})}
    {...(desktop?.updates?.restart ? { onRestart: () => mismatch ? desktop.updates.restart!() : desktop.updates.install() } : {})}
    {...(desktop?.updates?.prepare ? { onPrepare: () => { void desktop.updates.prepare(); } } : {})}
    {...(desktop?.updates?.cancel ? { onCancel: () => { void desktop.updates.cancel(); } } : {})}
    onRefresh={refreshFrontend} />;
}


/**
 * The environment could not be established (RP-13 B).
 *
 * Shaped like {@link VersionNotice}, deliberately: it is the same kind of
 * thing — a state the app cannot work in, which a person has to be told about
 * and given a way out of. So it wraps instead of truncating, it is legible on
 * a phone, and it stays until the environment *is* established rather than
 * flickering with the socket's reconnect attempts.
 *
 * The way out is the one that actually helps: this browser's stored data for
 * this app is what a failed purge is stuck on, so the button clears it and
 * reloads the view. Nothing on the host is touched by either.
 *
 * Clearing is **awaited**: conversations this device cached live in a database
 * (RP-10), deleting one is asynchronous, and another tab can block it. So the
 * button reports what happened rather than reloading on the assumption that it
 * worked — a reload that claimed success while the data was still there is the
 * one outcome this state exists to prevent.
 */
export function EnvironmentNotice({ reason, onClear }: { reason: string; onClear: () => boolean | void | Promise<boolean | void> }) {
  const [clearing, setClearing] = useState(false);
  const [stuck, setStuck] = useState(false);
  const clear = async (): Promise<void> => {
    setStuck(false);
    setClearing(true);
    try {
      // `false` is the one answer that must be shown: something is still here.
      setStuck((await onClear()) === false);
    } finally {
      setClearing(false);
    }
  };
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="environment-notice"
      className="relative z-110 flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 text-sm"
    >
      <CloudOffIcon aria-hidden="true" className="size-4 shrink-0 text-attention" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium text-ink">{PRODUCT_DISPLAY_NAME} cannot use this connection</p>
        <p className="mt-1 text-xs text-ink-2">{reason}</p>
        <p className="mt-1 text-xs text-ink-3">
          Nothing is being kept on this device while this lasts, and nothing on the host has changed. Reconnecting continues in the background.
        </p>
        {stuck && (
          <p data-slot="environment-notice-stuck" className="mt-1 text-xs text-attention">
            This browser is still holding on to the data. Close other tabs and windows of {PRODUCT_DISPLAY_NAME} and try again.
          </p>
        )}
      </div>
      {/* The one way out of this state, on the device most likely to be in it:
          a coarse pointer gets the 44px target DESIGN.md requires. */}
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:min-h-11"
        disabled={clearing}
        onClick={() => {
          void clear();
        }}
      >
        {clearing ? "Clearing…" : "Clear this browser’s data and reload"}
      </Button>
    </div>
  );
}

/** Runtime-bound wrapper: present exactly while no environment is established. */
export function HostEnvironmentNotice() {
  const reason = useLaserState((s) => s.environmentError);
  if (!reason) return null;
  return (
    <EnvironmentNotice
      reason={reason}
      onClear={async () => {
        // Proved, not assumed: the reload happens only once every store on this
        // device has reported that its data is gone.
        const cleared = await clearBrowserStorage();
        if (cleared) refreshFrontend();
        return cleared;
      }}
    />
  );
}

/**
 * The socket state as a phase: `connecting` before the first open is
 * "reconnecting" with `first`; `closed` after an open is "dropped"; the first
 * `open` after either is "resumed" for {@link RESUMED_MS}.
 */
export function useConnectionPhase(): { phase: ConnectionPhase; first: boolean } {
  const connection = useLaserState((s) => s.connection);
  const everOpen = useRef(false);
  const wasDown = useRef(false);
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    if (connection !== "open") {
      wasDown.current = true;
      return;
    }
    const cameBack = everOpen.current && wasDown.current;
    everOpen.current = true;
    wasDown.current = false;
    if (!cameBack) return;
    setResumed(true);
    const timer = setTimeout(() => setResumed(false), RESUMED_MS);
    return () => clearTimeout(timer);
  }, [connection]);

  const first = !everOpen.current;
  if (connection === "open") return { phase: resumed ? "resumed" : "online", first: false };
  if (connection === "connecting") return { phase: "reconnecting", first };
  return { phase: "dropped", first };
}

/** One quiet line under the top bar while the host is unreachable; absent when connected. */
export function HostConnectionState({ className }: { className?: string | undefined }) {
  const { client } = useLaserStable();
  const { phase, first } = useConnectionPhase();
  // An environment this view cannot establish has its own persistent notice
  // (`EnvironmentNotice`); this line stays about the socket.
  const environmentError = useLaserState((s) => s.environmentError);
  if (environmentError) return null;
  return (
    <ConnectionState
      phase={phase}
      first={first}
      onRetry={() => {
        client.close();
        client.connect();
      }}
      className={className}
    />
  );
}
