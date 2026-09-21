"use client";
/**
 * The reading form of a body's fields.
 *
 * Every kind's body is a closed schema (`@lasercode/protocol`), so the detail
 * shows what the schema holds and says nothing where a field is empty: an
 * empty section is not drawn, because a heading over nothing is noise, and a
 * body that is genuinely empty says so once, in words.
 *
 * Editing lives in M21-T7 (Spec, Research), M21-T13 (Design) and M21-T16
 * (Plan, Task). These components are the reading half those tasks keep.
 */
import type { ReactNode } from "react";

import { MarkdownDocument } from "@/components/assistant-ui/elements/markdown-document";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

/** A section that is only drawn when it has something in it. */
export function ListSection({ title, items, mono = false }: { title: string; items: readonly string[]; mono?: boolean }) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul role="list" className="flex flex-col gap-1">
        {items.map((text, index) => (
          <li key={`${index}-${text}`} className={cn("flex gap-2 text-sm leading-5 text-ink-2", mono && "typed break-all")}>
            <span aria-hidden="true" className="select-none text-ink-3">
              ·
            </span>
            <span className="min-w-0">{text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Prose({ text, className }: { text: string; className?: string }) {
  return <p className={cn("max-w-(--measure-prose) text-sm leading-5 whitespace-pre-wrap text-ink-2", className)}>{text}</p>;
}

/** Markdown, through the shared renderer. Never raw HTML (invariant 9). */
export function Document({ text }: { text: string }) {
  return (
    <Section title="Document">
      <MarkdownDocument text={text} measure="prose" />
    </Section>
  );
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span className="min-w-0 text-sm leading-5 text-ink">{children}</span>
    </div>
  );
}

export function Tags({ values, variant = "outline" }: { values: readonly string[]; variant?: "outline" | "default" }) {
  if (values.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {values.map((value) => (
        <Badge key={value} variant={variant}>
          {value}
        </Badge>
      ))}
    </span>
  );
}

/** What a body says when it is genuinely empty, rather than not yet loaded. */
export function EmptyBody({ what, next }: { what: string; next: string }) {
  return (
    <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
      {what} <span className="text-ink-3">{next}</span>
    </p>
  );
}
