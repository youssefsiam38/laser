"use client";
/**
 * Directive text (`directive-text`, the framework-neutral half): renders a
 * string whose `@file` / `@handle` directives become inline chips, everything
 * else as text. Never HTML (AGENTS.md inv. 9): the formatter parses, the
 * component renders segments.
 *
 * Divergences from the registry copy: the chip is our `Badge` in its default
 * variant, sized to the type scale (no 13px literal).
 */
import type { FC } from "react";

import { Badge } from "@/components/ui/badge";

type IconComponent = FC<{ className?: string }>;

export type DirectiveTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly type: string; readonly label: string; readonly id: string };

export type DirectiveTextFormatter = {
  /** Parse text into alternating text and directive segments. */
  parse(text: string): readonly DirectiveTextSegment[];
};

export type CreateDirectiveTextOptions = {
  /** Maps a directive `type` to an icon component. */
  iconMap?: Record<string, IconComponent>;
  /** Icon rendered when `iconMap` has no entry for the segment type. */
  fallbackIcon?: IconComponent;
};

/** Creates a text component that parses directive syntax and renders inline chips. */
export function createDirectiveText(formatter: DirectiveTextFormatter, options?: CreateDirectiveTextOptions): FC<{ text: string }> {
  const iconMap = options?.iconMap;
  const fallbackIcon = options?.fallbackIcon;

  const Component: FC<{ text: string }> = ({ text }) => {
    const segments = formatter.parse(text);
    if (segments.length === 1 && segments[0]!.kind === "text") return <>{text}</>;
    return (
      <>
        {segments.map((seg, i) => {
          if (seg.kind === "text") {
            return (
              <span key={i} className="whitespace-pre-wrap">
                {seg.text}
              </span>
            );
          }
          const Icon = iconMap?.[seg.type] ?? fallbackIcon;
          return (
            <Badge
              key={i}
              data-slot="directive-text-chip"
              data-directive-type={seg.type}
              data-directive-id={seg.id}
              aria-label={`${seg.type}: ${seg.label}`}
              className="mx-0.5 h-5 items-baseline px-1.5 align-baseline font-mono text-xs [&_svg]:self-center"
            >
              {Icon ? <Icon /> : null}
              {seg.label}
            </Badge>
          );
        })}
      </>
    );
  };
  Component.displayName = "DirectiveText";
  return Component;
}
