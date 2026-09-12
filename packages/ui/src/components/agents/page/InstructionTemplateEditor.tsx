"use client";

import {
  instructionTemplateFields,
  instructionTemplateToken,
  type InstructionTemplateField,
  type InstructionTemplateTarget,
} from "@lasercode/protocol";
import { Braces, Code2, PenLine, Search } from "lucide-react";
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { Hint } from "./fields.js";
import type { InstructionTemplateValueContext } from "./instruction-template-model.js";
import type { InstructionTemplateSourceProps } from "./InstructionTemplateSource.js";

const LazyInstructionTemplateSource = lazy(() =>
  import("./InstructionTemplateSource.js").then((module) => ({ default: module.InstructionTemplateSource })),
);

function PlainSource({ value, ariaLabel, invalid, className }: Pick<InstructionTemplateSourceProps, "value" | "ariaLabel" | "invalid" | "className">) {
  return (
    <pre dir="ltr"
      data-slot="instruction-template-source"
      data-highlighted="false"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cn("min-h-40 max-h-120 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm leading-code whitespace-pre-wrap wrap-break-word text-ink aria-invalid:border-danger", className)}
    ><code dir="ltr">{value}</code></pre>
  );
}

/** Shared read-only source view used by the editor and the shipped default. */
export function InstructionTemplateSourceView(props: InstructionTemplateSourceProps) {
  return (
    <Suspense fallback={<PlainSource value={props.value} ariaLabel={props.ariaLabel} invalid={props.invalid} className={props.className} />}>
      <LazyInstructionTemplateSource {...props} />
    </Suspense>
  );
}

export interface InstructionTemplateEditorProps {
  target: InstructionTemplateTarget;
  context: InstructionTemplateValueContext;
  value: string;
  ariaLabel?: string;
  placeholder?: string;
  maxLength?: number;
  invalid?: boolean;
  onChange(value: string): void;
}

function insertion(value: string, start: number, end: number, field: InstructionTemplateField): { value: string; caret: number } {
  const token = instructionTemplateToken(field.key);
  const prefix = field.placement === "block" && start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
  const suffix = field.placement === "block" && end < value.length && value[end] !== "\n" ? "\n\n" : "";
  const inserted = `${prefix}${token}${suffix}`;
  return { value: `${value.slice(0, start)}${inserted}${value.slice(end)}`, caret: start + inserted.length };
}

export function InstructionTemplateEditor({ target, context, value, ariaLabel, placeholder, maxLength, invalid, onChange }: InstructionTemplateEditorProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: value.length, end: value.length });
  const pendingSelection = useRef<{ start: number; end: number } | undefined>(undefined);
  const inserting = useRef(false);
  const [mode, setMode] = useState<"edit" | "source">("edit");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const fields = instructionTemplateFields(target);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? fields.filter((field) => `${field.label} ${field.description}`.toLowerCase().includes(needle)) : fields;
  }, [fields, query]);

  const rememberSelection = () => {
    const node = textarea.current;
    if (node) selection.current = { start: node.selectionStart, end: node.selectionEnd };
  };
  const clampSelection = (candidate = selection.current) => ({
    start: Math.min(candidate.start, value.length),
    end: Math.min(candidate.end, value.length),
  });
  const restoreEditor = (candidate = selection.current) => {
    const next = clampSelection(candidate);
    selection.current = next;
    if (mode === "edit") {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.start, next.end);
      return;
    }
    pendingSelection.current = next;
    setMode("edit");
  };
  useLayoutEffect(() => {
    if (mode !== "edit" || !pendingSelection.current) return;
    const next = clampSelection(pendingSelection.current);
    pendingSelection.current = undefined;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(next.start, next.end);
    selection.current = next;
  }, [mode, value]);
  const insert = (field: InstructionTemplateField) => {
    const node = textarea.current;
    const { start, end } = node ? { start: node.selectionStart, end: node.selectionEnd } : clampSelection();
    const next = insertion(value, start, end, field);
    if (maxLength !== undefined && next.value.length > maxLength) return;
    selection.current = { start: next.caret, end: next.caret };
    pendingSelection.current = selection.current;
    inserting.current = true;
    onChange(next.value);
    setMode("edit");
    setOpen(false);
    setQuery("");
  };
  const fits = (field: InstructionTemplateField) => {
    if (maxLength === undefined) return true;
    const { start, end } = clampSelection();
    return insertion(value, start, end, field).value.length <= maxLength;
  };

  return (
    <div data-slot="instruction-template-editor" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Instruction view" className="flex rounded-md border border-line bg-surface-2 p-0.5">
          <button
            type="button"
            aria-pressed={mode === "edit"}
            className={`flex min-h-8 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-live pointer-coarse:min-h-11 ${mode === "edit" ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
            onClick={() => restoreEditor()}
          >
            <PenLine aria-hidden className="size-3.5" />
            Edit
          </button>
          <button
            type="button"
            aria-pressed={mode === "source"}
            className={`flex min-h-8 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-live pointer-coarse:min-h-11 ${mode === "source" ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
            onPointerDown={rememberSelection}
            onClick={() => {
              rememberSelection();
              setMode("source");
            }}
          >
            <Code2 aria-hidden className="size-3.5" />
            Highlighted source
          </button>
        </div>
        <Hint>{mode === "edit" ? "Edit the Markdown source directly." : "Select a variable to inspect its current value."}</Hint>
      </div>
      {mode === "edit" ? (
        <Textarea
          ref={textarea}
          name="instructions"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          className="min-h-40 max-h-120 font-mono text-sm leading-code"
          onSelect={rememberSelection}
          onClick={rememberSelection}
          onKeyUp={rememberSelection}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <InstructionTemplateSourceView target={target} value={value} context={context} ariaLabel={`${ariaLabel ?? "Instructions"} highlighted source`} invalid={invalid} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Hint>Fields fill from the live session whenever the agent runs.</Hint>
        <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
          <PopoverTrigger asChild>
            <Button type="button" variant="secondary" size="sm" className="gap-1.5" onPointerDown={rememberSelection}>
              <Braces />
              Insert field
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[min(24rem,calc(100vw-2rem))] gap-3 p-3"
            onCloseAutoFocus={(event) => {
              if (!inserting.current) return;
              event.preventDefault();
              inserting.current = false;
              requestAnimationFrame(() => {
                const next = clampSelection();
                textarea.current?.focus();
                textarea.current?.setSelectionRange(next.start, next.end);
              });
            }}
          >
            <PopoverHeader>
              <PopoverTitle>Insert live information</PopoverTitle>
              <PopoverDescription>Choose what belongs at the cursor. No field names to remember.</PopoverDescription>
            </PopoverHeader>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-ink-3" />
              <Input
                value={query}
                aria-label="Find an instruction field"
                placeholder="Find a field"
                className="ps-9"
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div role="list" aria-label="Instruction fields" className="flex max-h-72 flex-col gap-1 overflow-y-auto overscroll-contain">
              {shown.map((field) => {
                const available = fits(field);
                return (
                  <button
                    key={field.key}
                    type="button"
                    role="listitem"
                    disabled={!available}
                    className="flex min-h-11 w-full flex-col items-start rounded-lg px-3 py-2 text-start outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => insert(field)}
                  >
                    <span className="text-sm font-medium text-ink">{field.label}</span>
                    <span className="text-xs leading-5 text-ink-2">{available ? field.description : "Not enough room remains for this field."}</span>
                  </button>
                );
              })}
              {shown.length === 0 ? <p className="m-0 px-3 py-4 text-center text-xs text-ink-2">No matching fields.</p> : null}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
