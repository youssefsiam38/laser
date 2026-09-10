"use client";
/**
 * Reasoning effort — the composer's thinking-level control
 * (docs/ux-elements.md "Reasoning"). Installed from `elements-reasoning-effort`
 * and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy, so a reviewer can diff them:
 *   - The seven Pi levels, `off` through `max`, not a demo trio. The labels
 *     are the levels' own names; the accessible name is the full word.
 *   - A `radiogroup` with roving focus and arrow keys, Home and End, not a
 *     row of `aria-pressed` buttons: one tab stop, every level reachable.
 *   - The "budget spent" progress bar is gone. Pi reports no thinking budget
 *     and no thinking token count per level, and a bar that cannot be filled
 *     is a fake (docs/ux-fleet.md R5, provenance honesty).
 *   - `ThinkingEffort` is the runtime-bound wrapper behind one compact
 *     popover at every width, so the composer never becomes a settings bar.
 *   - Only the levels the effective model accepts are offered
 *     (`ModelCatalogEntry.thinkingLevels`; Pi maps the rest to null). Before a
 *     session exists, that is the configured default agent/model; choosing a
 *     level first creates or reuses its empty session. A control appears only
 *     if it actually works here — and when a model does not reason at all the
 *     control is gone, with the reason in a tooltip where it would have been
 *     (docs/ux-fleet.md R4, capability honesty).
 */
import { useAui } from "@assistant-ui/react";
import type { ModelCatalogEntry, ThinkingLevel } from "@lasercode/protocol";
import { Brain } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState, useLaserView, useSessionMeta } from "@/runtime";
import { useSessionPreparation } from "@/components/thread/session-preparation";

import { readDraft, writeDraft } from "./draft-restore.js";
import { field } from "./surfaces.js";

export interface EffortLevel {
  key: string;
  /** Short enough for a segment; the full name goes in `name`. */
  label: string;
  /** Accessible name; defaults to `label`. */
  name?: string;
}

export interface ReasoningEffortProps
  extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  levels: readonly EffortLevel[];
  selectedKey: string | undefined;
  onSelect?: ((key: string) => void) | undefined;
  disabled?: boolean | undefined;
  /** The group's accessible name. */
  label?: string | undefined;
}

export function ReasoningEffort({
  levels,
  selectedKey,
  onSelect,
  disabled = false,
  label = "Thinking level",
  className,
  ...props
}: ReasoningEffortProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(
    0,
    levels.findIndex((level) => level.key === selectedKey),
  );

  const choose = (index: number) => {
    const level = levels[Math.max(0, Math.min(levels.length - 1, index))];
    if (!level || disabled) return;
    onSelect?.(level.key);
    groupRef.current
      ?.querySelectorAll<HTMLElement>('[role="radio"]')
      [levels.indexOf(level)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = levels.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(last, activeIndex + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, activeIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="reasoning-effort"
      onKeyDown={onKeyDown}
      className={cn(field, "flex h-7 items-center gap-0.5 rounded-full p-0.5", disabled && "opacity-50", className)}
      {...props}
    >
      {levels.map((level, index) => {
        const active = level.key === selectedKey;
        return (
          <button
            key={level.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={level.name ?? level.label}
            title={level.name ?? level.label}
            disabled={disabled}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => choose(index)}
            className={cn(
              "h-6 min-w-6 rounded-full px-2 text-xs leading-none font-medium tnum outline-none",
              "transition-[background-color,color] duration-(--motion-instant)",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              "disabled:cursor-not-allowed",
              active ? "bg-surface text-ink shadow-float-sm" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pi's seven levels, bound to the effective session/default model
// ---------------------------------------------------------------------------

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The project's model catalogue, fetched once per directory. Shared across
 * every mount so the composer and the regenerate menu ask the host once.
 */
interface ThinkingCatalog {
  models: readonly ModelCatalogEntry[];
  defaultProvider?: string | undefined;
  defaultModel?: string | undefined;
  defaultThinkingLevel?: ThinkingLevel | undefined;
}

const catalogCache = new Map<string, Promise<ThinkingCatalog>>();
const catalogListeners = new Map<string, Set<() => void>>();

/** Keep the pre-turn thinking control in step with the adjacent model picker. */
export function invalidateThinkingCatalog(cwd: string): void {
  catalogCache.delete(cwd);
  catalogListeners.get(cwd)?.forEach((listener) => listener());
}

/**
 * The levels the effective session/default model accepts, or `undefined` while that is
 * not known yet. Unknown means "offer everything": guessing a model has no
 * reasoning because a fetch is in flight would hide a working control.
 */
function useThinkingDefaults(): {
  supported: readonly ThinkingLevel[] | undefined;
  defaultLevel: ThinkingLevel | undefined;
  model: ModelCatalogEntry | undefined;
} {
  const { client, currentProject } = useLaserStable();
  const { session, model: sessionModel } = useSessionMeta();
  const snapshot = useLaserState((s) => s.agents.snapshot);
  const cwd = session?.cwd ?? currentProject;
  const [catalog, setCatalog] = useState<{ cwd: string; value: ThinkingCatalog }>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!cwd) return;
    const listeners = catalogListeners.get(cwd) ?? new Set<() => void>();
    const refresh = () => {
      setCatalog(undefined);
      setRevision((current) => current + 1);
    };
    listeners.add(refresh);
    catalogListeners.set(cwd, listeners);
    return () => {
      listeners.delete(refresh);
      if (listeners.size === 0) catalogListeners.delete(cwd);
    };
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      setCatalog(undefined);
      return;
    }
    let live = true;
    let pending = catalogCache.get(cwd);
    if (!pending) {
      pending = client.request("pi/models/catalog", { cwd });
      // A failed fetch must not poison the cache: the next mount retries.
      void pending.catch(() => catalogCache.delete(cwd));
      catalogCache.set(cwd, pending);
    }
    void pending.then(
      (next) => live && setCatalog({ cwd, value: next }),
      () => live && setCatalog(undefined),
    );
    return () => {
      live = false;
    };
  }, [client, cwd, revision]);

  return useMemo(() => {
    if (!cwd || catalog?.cwd !== cwd) return { supported: undefined, defaultLevel: undefined, model: undefined };
    const value = catalog.value;
    const defaultAgent = snapshot?.agents.find((agent) => agent.name === snapshot.defaultAgent);
    const modelRef = sessionModel ?? defaultAgent?.model ?? (
      value.defaultProvider && value.defaultModel
        ? { provider: value.defaultProvider, id: value.defaultModel }
        : undefined
    );
    const model = modelRef
      ? value.models.find((entry) => entry.provider === modelRef.provider && entry.id === modelRef.id)
      : undefined;
    return {
      supported: model?.thinkingLevels,
      defaultLevel: session ? undefined : (defaultAgent?.thinkingLevel ?? model?.thinkingLevel ?? value.defaultThinkingLevel),
      model,
    };
  }, [catalog, cwd, session, sessionModel, snapshot]);
}

export function useSupportedThinkingLevels(): readonly ThinkingLevel[] | undefined {
  return useThinkingDefaults().supported;
}

const THINKING_EFFORTS: readonly EffortLevel[] = [
  { key: "off", label: "off" },
  { key: "minimal", label: "min", name: "minimal" },
  { key: "low", label: "low" },
  { key: "medium", label: "med", name: "medium" },
  { key: "high", label: "high" },
  { key: "xhigh", label: "xhigh", name: "extra high" },
  { key: "max", label: "max" },
];

/**
 * The composer's thinking control: icon and current level open the full radiogroup.
 */
export function ThinkingEffort({ className, allowProjectLanding = true }: { className?: string | undefined; allowProjectLanding?: boolean | undefined }) {
  const { actions, client, dispatch, currentProject } = useLaserStable();
  const view = useLaserView();
  const aui = useAui();
  const { begin, pending: preparingSession } = useSessionPreparation();
  const pendingFinish = useRef<(() => void) | undefined>(undefined);
  const { thinkingLevel: sessionThinkingLevel, session, model: sessionModel } = useSessionMeta();
  const defaults = useThinkingDefaults();
  const supported = defaults.supported;
  const thinkingLevel = sessionThinkingLevel ?? defaults.defaultLevel;
  const model = sessionModel ?? defaults.model;
  const disabled = preparingSession || (!session && (!currentProject || !allowProjectLanding));
  const [saving, setSaving] = useState(false);
  const [draftTransfer, setDraftTransfer] = useState<{
    from: string | undefined;
    target: string;
    text: string;
    clearSource(): void;
    finishPreparation(): void;
  }>();

  useEffect(() => () => pendingFinish.current?.(), []);
  const beginPreparation = () => {
    const release = begin();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
      if (pendingFinish.current === finish) pendingFinish.current = undefined;
    };
    pendingFinish.current = finish;
    return finish;
  };

  useEffect(() => {
    if (!draftTransfer) return;
    if (view?.path !== draftTransfer.target || !session) {
      // Navigation is allowed while the host applies the override. Never hold
      // the newly opened conversation inert, or paste this draft into it.
      // Keep a recoverable copy on the intended target when the source was
      // the anonymous landing composer (there is no sidebar row to return to).
      if (!draftTransfer.from) {
        const saved = readDraft(draftTransfer.target)?.text;
        writeDraft(draftTransfer.target, saved && saved !== draftTransfer.text ? `${draftTransfer.text}\n\n${saved}` : draftTransfer.text);
      }
      draftTransfer.finishPreparation();
      setDraftTransfer(undefined);
      return;
    }
    const current = aui.composer.getState().text;
    if (!current) aui.composer.setText(draftTransfer.text);
    else if (current !== draftTransfer.text) aui.composer.setText(`${draftTransfer.text}\n\n${current}`);
    draftTransfer.clearSource();
    if (draftTransfer.from) writeDraft(draftTransfer.from, undefined);
    draftTransfer.finishPreparation();
    setDraftTransfer(undefined);
  }, [aui, draftTransfer, session, view]);

  const select = (key: string) => {
    const level = key as ThinkingLevel;
    if (disabled || saving) return;
    if (session) {
      const finishPreparation = beginPreparation();
      setSaving(true);
      void actions.setThinking(level).finally(() => { setSaving(false); finishPreparation(); });
      return;
    }
    if (!currentProject || !allowProjectLanding) return;
    const composer = aui.composer.getState();
    if (composer.attachments.length > 0) {
      actions.toast("warning", "Remove attachments before changing thinking. Your draft is unchanged.");
      return;
    }
    const finishPreparation = beginPreparation();
    const runtime = aui.threads.__internal_getAssistantRuntime?.();
    if (!runtime) { finishPreparation(); return; }
    const source = runtime.threads.getById(runtime.threads.getState().mainThreadId).composer;
    const from = view?.path;
    setSaving(true);
    void actions.newSession(currentProject)
      .then(async (target) => {
        const { state } = await client.request("pi/thinking/set", { path: target, level });
        dispatch({ type: "opened", state, select: false });
        if (composer.text) {
          setDraftTransfer({
            from, target, text: composer.text, finishPreparation,
            clearSource: () => {
              if (source.getState().text === composer.text) source.setText("");
            },
          });
        } else finishPreparation();
      })
      .catch((error: unknown) => {
        setDraftTransfer(undefined);
        finishPreparation();
        actions.toast("error", error instanceof Error ? error.message : String(error));
      })
      .finally(() => setSaving(false));
  };
  const efforts = useMemo(
    () => (supported ? THINKING_EFFORTS.filter((e) => supported.includes(e.key as ThinkingLevel)) : THINKING_EFFORTS),
    [supported],
  );

  // The model does not reason: there is no level to pick, so there is no
  // control — only the reason, where the control would have been.
  if (!session && !allowProjectLanding) return null;

  if (supported && efforts.every((effort) => effort.key === "off")) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="thinking-effort"
            tabIndex={0}
            role="note"
            aria-label={`${model?.name ?? model?.id ?? "This model"} does not reason, so there is no thinking level`}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md p-1 text-xs text-ink-3 outline-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              className,
            )}
          >
            <Brain aria-hidden="true" className="size-3.5" />
            <span data-slot="thinking-effort-level">off</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{model?.name ?? model?.id ?? "This model"} does not reason — no thinking level to set.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span data-slot="thinking-effort" className={cn("flex items-center", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || saving}
            aria-label={`Thinking: ${thinkingLevel ?? "unset"}`}
            title={`Thinking: ${thinkingLevel ?? "unset"}`}
            className="h-8 shrink-0 gap-1 px-1.5 text-xs text-ink-2 hover:text-ink"
          >
            <Brain aria-hidden="true" className="size-3.5 text-ink-3" />
            <span data-slot="thinking-effort-level">{THINKING_EFFORTS.find((effort) => effort.key === thinkingLevel)?.label ?? "unset"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-auto max-w-[calc(100vw-2rem)]">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <span className="eyebrow">Thinking</span>
            <span className="typed text-ink-3">{thinkingLevel ?? "unset"}</span>
          </div>
          <ReasoningEffort levels={efforts} selectedKey={thinkingLevel} onSelect={select} disabled={disabled || saving} className="max-w-full" />
        </PopoverContent>
      </Popover>
    </span>
  );
}
