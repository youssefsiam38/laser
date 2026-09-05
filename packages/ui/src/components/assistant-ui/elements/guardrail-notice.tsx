"use client";
/**
 * Guardrail notice (`elements-guardrail-notice`): something the app will not
 * do, in its own shape, with the nearest thing it can do instead. Project
 * trust declined, an insecure origin on a phone, `disableBuiltins` breaking
 * an agent. Written for a person: what is off, why, and what to do next.
 *
 * Divergences from the registry copy: the `attention` tone rather than amber
 * literals, alternatives are `Button`s (keyboard, focus ring), and there is
 * no `max-w-sm`.
 */
import { Shield } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export interface GuardrailAlternative {
  id: string;
  label: string;
}

export interface GuardrailNoticeProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  title: string;
  explanation: string;
  /** The rule's short name, `typed`: "trust", "https", "builtins". */
  policy?: string | undefined;
  alternatives?: readonly GuardrailAlternative[];
  onPick?: ((id: string) => void) | undefined;
}

export function GuardrailNotice({ title, explanation, policy, alternatives = [], onPick, className, ...props }: GuardrailNoticeProps) {
  return (
    <div data-slot="guardrail-notice" role="note" className={cn(paper, "flex w-full flex-col gap-2.5 rounded-2xl p-3", className)} {...props}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--attention)_14%,transparent)] text-attention">
          <Shield className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={title}>
          {title}
        </span>
        {policy ? <span className={cn(mono, "shrink-0 text-ink-3")}>{policy}</span> : null}
      </div>
      <p className="text-xs leading-4 text-ink-2">{explanation}</p>
      {alternatives.length > 0 && onPick ? (
        <div className="flex flex-wrap gap-1.5">
          {alternatives.map((alt) => (
            <Button key={alt.id} variant="outline" size="xs" onClick={() => onPick(alt.id)}>
              {alt.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
