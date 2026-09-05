import type { DecisionField, DecisionPanel } from "@piorbit/protocol";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useCountdown } from "@/components/thread/timing";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { modKey } from "@/format";
import { cn } from "@/lib/utils";
import { isModeChangingOption } from "../../decision.js";
import { blockingWords } from "../../values.js";

export interface DecisionBodyProps {
  panel: DecisionPanel;
  /** Answer with values keyed by field id, or cancel with `undefined`. */
  onAnswer(values: Record<string, string | boolean> | undefined): Promise<unknown>;
  /** Free-standing card vs. inside another surface. */
  variant?: "card" | "sheet";
  /**
   * Coarse pointer: one-hand controls. Everything an answer needs grows to a
   * 48px row at 14px, stacked full width and ordered so the primary action is
   * nearest the thumb. Same component, same states — a bigger budget, not a
   * second design (docs/ux-panels.md R13).
   */
  touch?: boolean;
  /** Start in the rejection state — a notification's "Deny…" opens the reason field. */
  initialDeclining?: boolean;
  autoFocus?: boolean;
  className?: string | undefined;
}

type Values = Record<string, string | boolean>;

/**
 * Something blocking on you: a field list, its blocking scope, and a
 * rejection field that opens on "No" so declining is never a dead end.
 *
 * The one decision renderer in the app. A tool-row footer, a card above the
 * composer and a session-blocking sheet are this component in three places,
 * which is why a question never looks like three different things.
 * Keyboard-first: Enter submits a one-line field, ⌘/Ctrl+Enter a long one,
 * Esc cancels, arrows move between choices.
 */
export function DecisionBody({
  panel,
  onAnswer,
  variant = "card",
  touch = false,
  initialDeclining = false,
  autoFocus = true,
  className,
}: DecisionBodyProps) {
  const id = useId();
  const [values, setValues] = useState<Values>(() => defaults(panel.fields));
  const [declining, setDeclining] = useState(initialDeclining);
  const [busy, setBusy] = useState(false);
  const secondsLeft = useCountdown(panel.timeoutMs);
  const rootRef = useRef<HTMLDivElement>(null);

  const rejectionField = panel.rejection ? panel.fields.find((f) => f.id === panel.rejection?.field) : undefined;
  const visible = panel.fields.filter((f) => f !== rejectionField);
  const single = visible.length === 1 ? visible[0] : undefined;
  const onlyConfirm = single?.type === "confirm";

  useEffect(() => {
    if (!autoFocus) return;
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (!declining) return;
    rootRef.current?.querySelector<HTMLElement>("[data-rejection]")?.focus({ preventScroll: true });
  }, [declining]);

  const submit = async (override?: Values): Promise<void> => {
    const next = { ...values, ...override };
    for (const field of visible) {
      if (field.required && field.type !== "confirm" && !String(next[field.id] ?? "").trim()) {
        rootRef.current?.querySelector<HTMLElement>(`[data-field="${field.id}"]`)?.focus();
        return;
      }
    }
    setBusy(true);
    try {
      await onAnswer(next);
    } finally {
      setBusy(false);
    }
  };

  const decline = (): void => {
    if (panel.rejection && rejectionField && !declining) {
      setDeclining(true);
      return;
    }
    void submit(onlyConfirm ? { [single!.id]: false } : {});
  };

  const cancel = (): void => void onAnswer(undefined);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (declining) setDeclining(false);
      else cancel();
      return;
    }
    if (single?.type === "choice" && ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) {
      const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? []);
      if (buttons.length === 0) return;
      e.preventDefault();
      const current = buttons.findIndex((b) => b === document.activeElement);
      const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
      buttons[current < 0 ? 0 : (current + (forward ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };

  const mod = modKey();
  // One place decides the control geometry, so the two shapes cannot drift.
  const btn = touch ? ("lg" as const) : ("sm" as const);
  const tall = touch ? "h-12 text-base" : "";
  const row = touch ? "flex-col" : "flex-wrap";

  return (
    <div ref={rootRef} role="group" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="eyebrow mb-1">
            {panel.source} · {blockingWords(panel.blocking)}
          </p>
          <p id={`${id}-title`} className={cn("font-medium text-ink", variant === "sheet" ? "text-base" : "text-sm")}>
            {panel.title}
          </p>
          {panel.message && <p className="mt-1 text-sm whitespace-pre-wrap text-ink-2">{panel.message}</p>}
        </div>
        {secondsLeft !== undefined && (
          <span className={cn("typed shrink-0 pt-0.5", secondsLeft <= 5 ? "text-attention" : "text-ink-3")} aria-live="polite">
            {secondsLeft}s
          </span>
        )}
      </div>

      {/* One choice field: the options are the answer. */}
      {single?.type === "choice" && !declining ? (
        <div className={cn("flex gap-2", row)} role="group" aria-label={single.label}>
          {(single.options ?? []).map((option, i) => {
            const modeChanging = isModeChangingOption(option);
            return (
              <Button
                key={`${i}-${option}`}
                variant="outline"
                size={btn}
                data-option
                {...(i === 0 ? { "data-autofocus": true } : {})}
                disabled={busy}
                onClick={() => void submit({ [single.id]: option })}
                className={cn(
                  // Choosing this changes how the session asks from now on, so
                  // it is marked before it is pressed, not explained after.
                  modeChanging && "border-[color-mix(in_oklab,var(--attention)_45%,var(--line))]",
                  touch && "h-auto min-h-12 w-full flex-col items-start gap-0.5 py-2.5 text-start text-base whitespace-normal",
                )}
              >
                <span className={cn(touch && "w-full wrap-break-word")}>{option}</span>
                {modeChanging && (
                  <span className={cn("font-normal text-attention", touch ? "text-xs" : "sr-only")}>
                    Changes how this session asks from now on
                  </span>
                )}
              </Button>
            );
          })}
          {panel.rejection && rejectionField ? (
            <Button variant="ghost" size={btn} className={cn(touch && "h-11 text-base text-ink-2")} onClick={decline}>
              {panel.rejection.label}
            </Button>
          ) : (
            <Button variant="ghost" size={btn} className={cn(touch && "h-11 text-base text-ink-2")} onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      ) : onlyConfirm && !declining ? (
        // On a phone the primary sits on the right, wider, where the thumb is.
        <div className={cn("flex gap-2", touch ? "" : "flex-wrap")}>
          <Button
            variant="outline"
            size={btn}
            className={cn(tall, touch && "flex-1")}
            onClick={decline}
          >
            {panel.rejection?.label ?? "No"}
          </Button>
          <Button size={btn} data-autofocus disabled={busy} className={cn(tall, touch && "flex-[1.6]")} onClick={() => void submit({ [single!.id]: true })}>
            Yes
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(onlyConfirm ? { [single!.id]: false } : {});
          }}
        >
          {!declining &&
            visible.map((field, i) => (
              <Field key={field.id} field={field} value={values[field.id]} first={i === 0} onChange={(v) => setValues((s) => ({ ...s, [field.id]: v }))} onSubmit={() => void submit()} />
            ))}
          {declining && rejectionField && (
            <Field field={rejectionField} value={values[rejectionField.id]} first rejection onChange={(v) => setValues((s) => ({ ...s, [rejectionField.id]: v }))} onSubmit={() => void submit(onlyConfirm ? { [single!.id]: false } : {})} />
          )}
          <div className={cn("flex items-center gap-2", touch ? "" : "flex-wrap")}>
            {declining ? (
              <Button type="button" variant="ghost" size={btn} className={cn(tall, touch && "flex-1")} onClick={() => setDeclining(false)}>
                Back
              </Button>
            ) : panel.rejection && rejectionField && !onlyConfirm ? (
              <Button type="button" variant="ghost" size={btn} className={cn(tall, touch && "flex-1")} onClick={decline}>
                {panel.rejection.label}
              </Button>
            ) : null}
            <Button type="submit" size={btn} disabled={busy} variant={declining ? "destructive" : "default"} className={cn(tall, touch && "flex-[1.6]")}>
              {declining ? `${panel.rejection?.label ?? "No"} and send` : "Submit"}
            </Button>
            {!touch && (
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            )}
            <span className="ms-auto hidden items-center gap-1 text-xs text-ink-3 sm:inline-flex" aria-hidden="true">
              {visible.some((f) => f.type === "longtext") || declining ? (
                <>
                  <Kbd>{mod}</Kbd>
                  <Kbd>⏎</Kbd>
                </>
              ) : (
                <Kbd>⏎</Kbd>
              )}
              <span className="ms-0.5">submit</span>
            </span>
          </div>
        </form>
      )}
    </div>
  );
}

function defaults(fields: readonly DecisionField[]): Values {
  const out: Values = {};
  for (const field of fields) if (field.default !== undefined) out[field.id] = field.default;
  return out;
}

interface FieldProps {
  field: DecisionField;
  value: string | boolean | undefined;
  first: boolean;
  rejection?: boolean;
  onChange(value: string | boolean): void;
  onSubmit(): void;
}

function Field({ field, value, first, rejection = false, onChange, onSubmit }: FieldProps) {
  const id = useId();
  const focus = first ? (rejection ? { "data-rejection": true } : { "data-autofocus": true }) : {};
  const inputClass = cn(
    "h-8 min-w-0 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink outline-none",
    "placeholder:text-ink-3 hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
    "focus-visible:border-live focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live/25",
  );
  switch (field.type) {
    case "confirm":
      return (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" data-field={field.id} {...focus} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} className="size-4 accent-(--live)" />
          {field.label}
        </label>
      );
    case "choice":
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs text-ink-2">{field.label}</legend>
          <div className="flex flex-wrap gap-2" data-field={field.id}>
            {(field.options ?? []).map((option, i) => (
              <Button key={`${i}-${option}`} type="button" size="sm" variant={value === option ? "default" : "outline"} aria-pressed={value === option} data-option {...(i === 0 ? focus : {})} onClick={() => onChange(option)}>
                {option}
              </Button>
            ))}
          </div>
        </fieldset>
      );
    case "text":
      return (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-2">{field.label}</span>
          <input id={id} data-field={field.id} {...focus} value={typeof value === "string" ? value : ""} required={field.required} onChange={(e) => onChange(e.currentTarget.value)} className={inputClass} />
        </label>
      );
    case "longtext":
      return (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-2">{field.label}</span>
          <Textarea
            data-field={field.id}
            {...focus}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
              }
            }}
            className="max-h-72 min-h-24 text-sm"
            spellCheck={!rejection ? false : true}
          />
        </label>
      );
  }
}
