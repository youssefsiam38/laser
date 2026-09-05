"use client";
/**
 * Elicitation form — "a server pausing mid-tool-call to ask you for the fields
 * it still needs" (docs/ux-elements.md "Tool use": a `decision` panel with more
 * than one field). Installed from `elements-elicitation-form`. `DecisionBody`
 * chooses it for any decision that has something to type — several fields, a
 * text or long-text question, or the rejection field that opens after "No".
 *
 * Divergences from the registry copy:
 *   - The fields are real controls, not the demo's static values: a text
 *     input, a textarea (⌘/Ctrl+Enter submits), choice buttons, a checkbox.
 *     They follow the payload's `DecisionField` type (R12a).
 *   - Values and their changes belong to the controller; this is a form.
 *   - The action row is the caller's words: Submit or "<Decline> and send", an
 *     optional secondary (Back, or the rejection label), Cancel.
 *   - No card chrome; the surface supplies it.
 */
import type { DecisionField } from "@lasercode/protocol";
import { MessageSquareText } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { DecisionHeader, type DecisionHeaderProps } from "./approval-card.js";

export type FieldValues = Record<string, string | boolean>;

export type ElicitationFormProps = Omit<ComponentProps<"form">, "children" | "title" | "onSubmit" | "onChange"> &
  DecisionHeaderProps & {
    touch: boolean;
    busy: boolean;
    fields: readonly DecisionField[];
    values: FieldValues;
    onChange(fieldId: string, value: string | boolean): void;
    onSubmit(): void;
    submitLabel: string;
    /** The submit answers "no": drawn as the destructive action. */
    destructive?: boolean;
    /** Back, or the rejection label. */
    secondary?: { label: string; onClick(): void } | undefined;
    onCancel?: (() => void) | undefined;
    /** Which focus marker the first field carries, so the controller can find it. */
    focusMarker?: "data-autofocus" | "data-rejection";
    /** Keyboard hint, drawn by the caller. */
    hint?: ReactNode;
  };

export function ElicitationForm({
  titleId,
  eyebrow,
  title,
  message,
  secondsLeft,
  icon = MessageSquareText,
  large,
  touch,
  busy,
  fields,
  values,
  onChange,
  onSubmit,
  submitLabel,
  destructive = false,
  secondary,
  onCancel,
  focusMarker = "data-autofocus",
  hint,
  className,
  ...props
}: ElicitationFormProps) {
  const size = touch ? ("lg" as const) : ("sm" as const);
  const tall = touch ? "h-12 text-base" : "";
  return (
    <form
      data-slot="elicitation-form"
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      {...props}
    >
      <DecisionHeader titleId={titleId} eyebrow={eyebrow} title={title} message={message} secondsLeft={secondsLeft} icon={icon} large={large} />

      <div className="flex flex-col gap-3">
        {fields.map((field, i) => (
          <Field key={field.id} field={field} value={values[field.id]} focus={i === 0 ? focusMarker : undefined} onChange={(v) => onChange(field.id, v)} onSubmit={onSubmit} />
        ))}
      </div>

      <div className={cn("flex items-center gap-2", touch ? "" : "flex-wrap")}>
        {secondary && (
          <Button type="button" variant="ghost" size={size} className={cn(tall, touch && "flex-1")} onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
        <Button type="submit" size={size} disabled={busy} variant={destructive ? "destructive" : "default"} className={cn(tall, touch && "flex-[1.6]")}>
          {submitLabel}
        </Button>
        {!touch && onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {hint}
      </div>
    </form>
  );
}

interface FieldProps {
  field: DecisionField;
  value: string | boolean | undefined;
  focus: "data-autofocus" | "data-rejection" | undefined;
  onChange(value: string | boolean): void;
  onSubmit(): void;
}

function Field({ field, value, focus, onChange, onSubmit }: FieldProps) {
  const id = useId();
  const marker = focus ? { [focus]: true } : {};
  const inputClass = cn(
    "h-8 min-w-0 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink outline-none",
    "placeholder:text-ink-3 hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
    "focus-visible:border-live focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live/25",
  );
  switch (field.type) {
    case "confirm":
      return (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" data-field={field.id} {...marker} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} className="size-4 accent-(--live)" />
          {field.label}
        </label>
      );
    case "choice":
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs text-ink-2">{field.label}</legend>
          <div className="flex flex-wrap gap-2" data-field={field.id}>
            {(field.options ?? []).map((option, i) => (
              <Button key={`${i}-${option}`} type="button" size="sm" variant={value === option ? "default" : "outline"} aria-pressed={value === option} data-option {...(i === 0 ? marker : {})} onClick={() => onChange(option)}>
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
          <input id={id} data-field={field.id} {...marker} value={typeof value === "string" ? value : ""} required={field.required} onChange={(e) => onChange(e.currentTarget.value)} className={inputClass} />
        </label>
      );
    case "longtext":
      return (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-2">{field.label}</span>
          <Textarea
            data-field={field.id}
            {...marker}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
              }
            }}
            className="max-h-72 min-h-24 text-sm"
            spellCheck={focus === "data-rejection"}
          />
        </label>
      );
  }
}
