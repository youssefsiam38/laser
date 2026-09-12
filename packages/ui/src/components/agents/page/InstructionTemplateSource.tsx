"use client";

import type { InstructionTemplateTarget } from "@lasercode/protocol";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useShikiHighlighter } from "react-shiki";

import { LASER_SHIKI_THEME, SHIKI_ENGINE } from "@/components/assistant-ui/elements/shiki-theme";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import {
  instructionTemplateValue,
  instructionTemplateVariables,
  type InstructionTemplateValueContext,
  type InstructionTemplateVariable,
} from "./instruction-template-model.js";

interface SyntaxToken {
  readonly content: string;
  readonly color?: string | undefined;
  readonly fontStyle?: number | undefined;
}

interface SyntaxRange extends Omit<SyntaxToken, "content"> {
  start: number;
  end: number;
}

export interface InstructionTemplateSourceProps {
  target: InstructionTemplateTarget;
  value: string;
  context: InstructionTemplateValueContext;
  ariaLabel?: string | undefined;
  invalid?: boolean | undefined;
  className?: string | undefined;
}

const sourceClassName = cn(
  "min-h-40 max-h-120 overflow-auto rounded-lg border border-line bg-surface-2 p-3",
  "font-mono text-sm leading-code whitespace-pre-wrap wrap-break-word text-ink outline-none",
  "focus-within:ring-2 focus-within:ring-live aria-invalid:border-danger",
);

/** Exact-source fallback while the Markdown grammar loads. */
export function PlainInstructionTemplateSource({ value, ariaLabel, invalid, className }: Pick<InstructionTemplateSourceProps, "value" | "ariaLabel" | "invalid" | "className">) {
  return (
    <pre dir="ltr"
      data-slot="instruction-template-source"
      data-highlighted="false"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cn(sourceClassName, className)}
    ><code dir="ltr">{value}</code></pre>
  );
}

/**
 * Converts Shiki's line tokens back to ranges in the original string. If one
 * line does not round-trip exactly, that line stays plain rather than moving or
 * normalizing source text.
 */
export function instructionSyntaxRanges(source: string, lines: readonly (readonly SyntaxToken[])[] | undefined): SyntaxRange[] {
  if (!lines) return [];
  const sourceLines = source.split("\n");
  const ranges: SyntaxRange[] = [];
  let lineStart = 0;
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const sourceLine = sourceLines[lineIndex] ?? "";
    const tokens = lines[lineIndex];
    if (tokens && tokens.map((token) => token.content).join("") === sourceLine) {
      let offset = lineStart;
      for (const token of tokens) {
        if (token.content.length > 0) {
          ranges.push({ start: offset, end: offset + token.content.length, color: token.color, fontStyle: token.fontStyle });
          offset += token.content.length;
        }
      }
    }
    lineStart += sourceLine.length + (lineIndex < sourceLines.length - 1 ? 1 : 0);
  }
  return ranges;
}

function tokenStyle(token: Pick<SyntaxToken, "color" | "fontStyle"> | undefined): CSSProperties | undefined {
  if (!token) return undefined;
  const fontStyle = token.fontStyle ?? 0;
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? "italic" : undefined,
    fontWeight: fontStyle & 2 ? "bold" : undefined,
    textDecoration: fontStyle & 4 ? "underline" : undefined,
  };
}

function SourceVariable({ variable, context }: { variable: InstructionTemplateVariable; context: InstructionTemplateValueContext }) {
  const field = variable.field;
  const current = instructionTemplateValue(field.key, context);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="instruction-template-variable"
          data-field={field.key}
          aria-label={`Inspect ${field.label} variable`}
          className={cn(
            "inline rounded-sm bg-[color-mix(in_oklab,var(--syntax-variable)_12%,transparent)] text-[var(--syntax-variable)] underline decoration-current/50 underline-offset-2",
            "outline-none hover:bg-[color-mix(in_oklab,var(--syntax-variable)_18%,transparent)] focus-visible:ring-2 focus-visible:ring-live",
            "pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center",
          )}
        >{variable.token}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-var(--space-unit)*8))] gap-3">
        <PopoverHeader>
          <PopoverTitle>{field.label}</PopoverTitle>
          <PopoverDescription>{field.description}</PopoverDescription>
        </PopoverHeader>
        <code dir="ltr" className="w-fit rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs text-[var(--syntax-variable)]">{variable.token}</code>
        {current.status === "known" ? (
          <div className="min-w-0">
            <p className="eyebrow mb-1">Current value</p>
            <pre dir="ltr" data-slot="instruction-template-current-value" className="max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-surface-2 p-2 font-mono text-xs leading-code text-ink">{current.value || "Empty"}</pre>
            <p className="mt-1 text-xs text-ink-3">{current.provenance}</p>
          </div>
        ) : (
          <div data-slot="instruction-template-runtime-value" className="rounded-md bg-surface-2 p-2">
            <p className="text-sm font-medium text-ink">Resolved when the agent runs</p>
            <p className="mt-1 text-xs leading-5 text-ink-2">{current.reason}</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function highlightedSource(
  source: string,
  target: InstructionTemplateTarget,
  context: InstructionTemplateValueContext,
  syntax: readonly SyntaxRange[],
): ReactNode[] {
  const variables = instructionTemplateVariables(source, target);
  const boundaries = new Set<number>([0, source.length]);
  for (const range of syntax) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const variable of variables) {
    boundaries.add(variable.start);
    boundaries.add(variable.end);
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const nodes: ReactNode[] = [];
  let boundaryIndex = 0;
  let variableIndex = 0;
  let syntaxIndex = 0;
  while (boundaryIndex < ordered.length - 1) {
    const start = ordered[boundaryIndex] ?? source.length;
    const variable = variables[variableIndex];
    if (variable && start === variable.start) {
      nodes.push(<SourceVariable key={`variable:${start}`} variable={variable} context={context} />);
      while ((ordered[boundaryIndex] ?? source.length) < variable.end) boundaryIndex += 1;
      variableIndex += 1;
      continue;
    }
    const end = ordered[boundaryIndex + 1] ?? source.length;
    const text = source.slice(start, end);
    if (text) {
      while (syntax[syntaxIndex] && (syntax[syntaxIndex]?.end ?? 0) <= start) syntaxIndex += 1;
      const range = syntax[syntaxIndex];
      const style = tokenStyle(range && range.start <= start && range.end >= end ? range : undefined);
      nodes.push(style ? <span key={`syntax:${start}`} style={style}>{text}</span> : text);
    }
    boundaryIndex += 1;
  }
  return nodes;
}

/** Markdown syntax colours over exact source, with variables layered as controls. */
export function InstructionTemplateSource({ target, value, context, ariaLabel, invalid, className }: InstructionTemplateSourceProps) {
  const highlighted = useShikiHighlighter(value, "md", LASER_SHIKI_THEME, {
    engine: SHIKI_ENGINE,
    outputFormat: "tokens",
    delay: 150,
  });
  const syntax = useMemo(() => instructionSyntaxRanges(value, highlighted?.tokens), [highlighted?.tokens, value]);
  const content = useMemo(() => highlightedSource(value, target, context, syntax), [context, syntax, target, value]);
  return (
    <pre dir="ltr"
      data-slot="instruction-template-source"
      data-highlighted={highlighted ? "true" : "false"}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cn(sourceClassName, className)}
    ><code dir="ltr">{content}</code></pre>
  );
}
