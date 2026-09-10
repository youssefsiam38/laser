"use client";

import {
  instructionTemplateFields,
  instructionTemplateToken,
  type InstructionTemplateField,
  type InstructionTemplateTarget,
} from "@lasercode/protocol";
import { Braces, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

import { Hint } from "./fields.js";

export interface InstructionTemplateEditorProps {
  target: InstructionTemplateTarget;
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

export function InstructionTemplateEditor({ target, value, ariaLabel, placeholder, maxLength, invalid, onChange }: InstructionTemplateEditorProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: value.length, end: value.length });
  const pendingCaret = useRef<number | undefined>(undefined);
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
  const insert = (field: InstructionTemplateField) => {
    const node = textarea.current;
    const { start, end } = node ? { start: node.selectionStart, end: node.selectionEnd } : selection.current;
    const next = insertion(value, start, end, field);
    pendingCaret.current = next.caret;
    onChange(next.value);
    setOpen(false);
    setQuery("");
  };

  return (
    <div data-slot="instruction-template-editor" className="flex flex-col gap-2">
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
              const caret = pendingCaret.current;
              if (caret === undefined) return;
              event.preventDefault();
              pendingCaret.current = undefined;
              textarea.current?.focus();
              textarea.current?.setSelectionRange(caret, caret);
              selection.current = { start: caret, end: caret };
            }}
          >
            <PopoverHeader>
              <PopoverTitle>Insert live information</PopoverTitle>
              <PopoverDescription>Choose what belongs at the cursor. No field names to remember.</PopoverDescription>
            </PopoverHeader>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
              <Input
                value={query}
                aria-label="Find an instruction field"
                placeholder="Find a field"
                className="pl-9"
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div role="list" aria-label="Instruction fields" className="flex max-h-72 flex-col gap-1 overflow-y-auto overscroll-contain">
              {shown.map((field) => (
                <button
                  key={field.key}
                  type="button"
                  role="listitem"
                  className="flex min-h-11 w-full flex-col items-start rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-live"
                  onClick={() => insert(field)}
                >
                  <span className="text-sm font-medium text-ink">{field.label}</span>
                  <span className="text-xs leading-5 text-ink-2">{field.description}</span>
                </button>
              ))}
              {shown.length === 0 ? <p className="m-0 px-3 py-4 text-center text-xs text-ink-2">No matching fields.</p> : null}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
