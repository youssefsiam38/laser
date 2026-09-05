"use client";
/**
 * Quote reply (`elements-quote-reply`): the quoted block on the message you
 * are replying to. Pairs with `quote` in the composer: the composer folds a
 * quote into the prompt as a markdown blockquote, and this renders the
 * leading blockquote of a sent prompt back as a quote.
 *
 * Divergences from the registry copy: the registry is a demo of the whole
 * flow (highlighted selection, toolbar, quoted block). The toolbar is `quote`'s
 * `SelectionToolbar`; what survives here is the quoted block, plus the pure
 * `splitLeadingQuote` that recovers a quote from prompt text.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

/**
 * Splits a prompt into its leading blockquote (without the `> ` markers) and
 * the rest. A prompt that does not start with `> ` returns no quote.
 */
export function splitLeadingQuote(text: string): { quote: string | undefined; rest: string } {
  const lines = text.split("\n");
  const quoted: string[] = [];
  let i = 0;
  while (i < lines.length && /^> ?/.test(lines[i]!)) {
    quoted.push(lines[i]!.replace(/^> ?/, ""));
    i++;
  }
  if (quoted.length === 0) return { quote: undefined, rest: text };
  return { quote: quoted.join("\n").trim(), rest: lines.slice(i).join("\n").replace(/^\n+/, "") };
}

export interface QuoteReplyProps extends Omit<ComponentProps<"div">, "children"> {
  text: string;
}

export function QuoteReply({ text, className, ...props }: QuoteReplyProps) {
  return (
    <div data-slot="quote-reply" className={cn("flex min-w-0 flex-col gap-1", className)} {...props}>
      <span className={cn(mono, "text-ink-3")}>quoting</span>
      <blockquote className="line-clamp-4 min-w-0 border-s-2 border-line ps-2.5 text-xs leading-4 wrap-break-word whitespace-pre-wrap text-ink-2">{text}</blockquote>
    </div>
  );
}
