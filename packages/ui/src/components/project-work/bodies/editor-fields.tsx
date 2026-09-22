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
import { useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { MarkdownAuthoringField } from "../MarkdownAuthoringField.js";

/** A labelled block inside an editor. The label is a real `<label>` where it can be. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  action,
}: {
  label: string;
  hint?: ReactNode | undefined;
  error?: string | undefined;
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
      {error ? <p role="alert" className="max-w-(--measure-prose) text-xs leading-xs text-danger">{error}</p> : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  editorKey,
  maxLength,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  editorKey?: string;
  maxLength?: number;
}) {
  return (
    <MarkdownAuthoringField
      editorKey={editorKey ?? label}
      label={label}
      value={value}
      onChange={onChange}
      {...(typeof hint === "string" ? { hint } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(maxLength !== undefined ? { maxLength } : {})}
    />
  );
}

/** A list of one-line values: add, edit, remove. Order is the person's. */
export function LineListField({
  label,
  hint,
  error,
  values,
  onChange,
  placeholder,
  addLabel,
  maxLength,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
  maxLength?: number | undefined;
}) {
  const set = (index: number, value: string): void => onChange(values.map((existing, at) => (at === index ? value : existing)));
  const remove = (index: number): void => onChange(values.filter((_, at) => at !== index));
  return (
    <Field label={label} hint={hint} error={error}>
      <ul role="list" className="flex flex-col gap-1.5">
        {values.map((value, index) => (
          // The index is the identity here: these are ordered lines a person
          // is typing into, and a value-based key would remount on every edit.
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            <Input
              value={value}
              placeholder={placeholder}
              aria-label={`${label} ${index + 1}`}
              {...(maxLength !== undefined ? { maxLength } : {})}
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

let proseRowCounter = 0;
const proseRowId = (): string => `prose-row-${++proseRowCounter}`;

/** An ordered prose list: every row gets the same highlighted Write/Preview path. */
export function MarkdownListField({
  label,
  hint,
  error,
  values,
  onChange,
  placeholder,
  addLabel,
  editorKey,
  maxLength,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
  editorKey: string;
  maxLength?: number | undefined;
}) {
  // IDs belong only to this draft UI; protocol rows remain plain strings. A
  // removal must move the surviving editor, including its undo and selection,
  // rather than handing that state to whichever value inherits its index.
  const rowIds = useRef<string[]>([]);
  while (rowIds.current.length < values.length) rowIds.current.push(proseRowId());
  if (rowIds.current.length > values.length) rowIds.current.length = values.length;
  const set = (index: number, value: string): void => onChange(values.map((existing, at) => (at === index ? value : existing)));
  const remove = (index: number): void => {
    rowIds.current = rowIds.current.filter((_, at) => at !== index);
    onChange(values.filter((_, at) => at !== index));
  };
  const add = (): void => {
    rowIds.current.push(proseRowId());
    onChange([...values, ""]);
  };
  return (
    <Field label={label} hint={hint} error={error}>
      <ul role="list" className="flex flex-col gap-2">
        {values.map((value, index) => (
          <li key={rowIds.current[index]} data-row-id={rowIds.current[index]} className="flex min-w-0 items-start gap-1.5 rounded-lg border border-line p-2">
            <div className="min-w-0 flex-1">
              <MarkdownAuthoringField
                editorKey={`${editorKey}-${rowIds.current[index]}`}
                label={`${label} ${index + 1}`}
                value={value}
                onChange={(next) => set(index, next)}
                placeholder={placeholder}
                {...(maxLength !== undefined ? { maxLength } : {})}
              />
            </div>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${label.toLocaleLowerCase()} ${index + 1}`} onClick={() => remove(index)}>
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button size="xs" variant="outline" onClick={add}>
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
  editorKey,
  maxLength,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  editorKey?: string;
  maxLength?: number;
  error?: string | undefined;
}) {
  return (
    <MarkdownAuthoringField
      editorKey={editorKey ?? label}
      label={label}
      value={value}
      onChange={onChange}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(maxLength !== undefined ? { maxLength } : {})}
      {...(error !== undefined ? { error } : {})}
    />
  );
}
