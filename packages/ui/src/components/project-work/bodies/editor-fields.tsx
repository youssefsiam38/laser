"use client";
/**
 * The writing half of a body's fields (M21-T7).
 *
 * `fields.tsx` is the reading half; these are the same sections with an input
 * in them, and they follow the same rule: a field is drawn because the schema
 * has it, never to fill a shape. Every control is labelled, reachable by
 * keyboard, 44px under a coarse pointer, and made of tokens.
 */
import { Plus, X } from "lucide-react";
import { useId, type ReactNode } from "react";

import { MarkdownDocument } from "@/components/assistant-ui/elements/markdown-document";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** A labelled block inside an editor. The label is a real `<label>` where it can be. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  action,
}: {
  label: string;
  hint?: ReactNode | undefined;
  htmlFor?: string | undefined;
  children: ReactNode;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        {htmlFor ? (
          <label className="eyebrow" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="eyebrow">{label}</span>
        )}
        {action}
      </div>
      {children}
      {hint ? <p className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn("max-h-64 text-sm leading-5", className)}
      />
    </Field>
  );
}

/** A list of one-line values: add, edit, remove. Order is the person's. */
export function LineListField({
  label,
  hint,
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  label: string;
  hint?: ReactNode;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  const set = (index: number, value: string): void => onChange(values.map((existing, at) => (at === index ? value : existing)));
  const remove = (index: number): void => onChange(values.filter((_, at) => at !== index));
  return (
    <Field label={label} hint={hint}>
      <ul role="list" className="flex flex-col gap-1.5">
        {values.map((value, index) => (
          // The index is the identity here: these are ordered lines a person
          // is typing into, and a value-based key would remount on every edit.
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            <Input
              value={value}
              placeholder={placeholder}
              aria-label={`${label} ${index + 1}`}
              onChange={(event) => set(index, event.target.value)}
              className="h-8 text-sm"
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${label.toLocaleLowerCase()} ${index + 1}`}
              onClick={() => remove(index)}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button size="xs" variant="outline" onClick={() => onChange([...values, ""])}>
          <Plus />
          {addLabel}
        </Button>
      </div>
    </Field>
  );
}

/** One row of mutually exclusive choices. A real radio group, not a toggle pair. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex w-fit items-center gap-0.5 rounded-lg border border-line p-0.5", className)}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-7 items-center rounded-md px-2.5 text-xs leading-xs outline-none",
              "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              "pointer-coarse:min-h-11",
              on ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Markdown with its two faces: the source a person types, and the document
 * that source becomes, drawn through the one shared renderer. Never raw HTML
 * (invariant 9), and the preview is the same renderer the reading form uses,
 * so nothing looks different once it is saved.
 */
export function MarkdownField({
  label,
  value,
  onChange,
  placeholder,
  view,
  onViewChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  view: "source" | "preview";
  onViewChange: (view: "source" | "preview") => void;
}) {
  const id = useId();
  return (
    <Field
      label={label}
      htmlFor={view === "source" ? id : undefined}
      action={
        <Segmented
          label={`${label} view`}
          value={view}
          onChange={onViewChange}
          options={[
            { value: "source", label: "Source" },
            { value: "preview", label: "Preview" },
          ]}
        />
      }
    >
      {view === "source" ? (
        <Textarea
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="typed max-h-[28rem] min-h-48 leading-5"
        />
      ) : value.trim() === "" ? (
        <p className="rounded-lg border border-line bg-surface p-3 text-sm leading-5 text-ink-3">
          Nothing written yet. Switch to Source and start the document.
        </p>
      ) : (
        <div data-slot="markdown-preview" className="rounded-lg border border-line bg-surface p-3">
          <MarkdownDocument text={value} measure="prose" />
        </div>
      )}
    </Field>
  );
}
