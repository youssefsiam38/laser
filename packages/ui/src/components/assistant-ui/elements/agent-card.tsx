"use client";
/**
 * Agent card — an agent definition on the Agents page (docs/ux-elements.md
 * "Agent card", D-140, M13-T5). Installed from `elements-agent-card` and
 * restyled to DESIGN.md tokens.
 *
 * The registry file is a directory entry for a remote agent: name, version,
 * provider, endpoint, a skill list and a Connect button. Laser's agents are
 * definitions the person wrote, not services to connect to, so the card
 * keeps the shape — a mark, a name, one line of description, a run of facts,
 * a footer of actions — and drops what has no meaning here.
 *
 * Divergences from the registry copy, each on purpose:
 *   - `version`, `provider`, `endpoint`, `connected` and `onConnect` are gone;
 *     the footer carries whatever actions the caller declares.
 *   - `skills` became `facts`: label/value pairs (model, tools, what it may
 *     start, scoped-skill state), typed values in mono, a tone for the ones
 *     that need attention.
 *   - `badges` sits beside the name (Default, warning count); `eyebrow` above
 *     it names the kind (Built in, Your agent).
 *   - Every colour, radius and size reads a token; the 13.5px title and the
 *     `foreground/45` alphas are gone.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export interface AgentCardFact {
  label: string;
  value: string;
  /** Draw the value in mono (a model id, a count). */
  typed?: boolean | undefined;
  tone?: "attention" | "muted" | "ok" | undefined;
  /** Full text when the value truncates. */
  title?: string | undefined;
}

const FACT_TONE: Record<NonNullable<AgentCardFact["tone"]>, string> = {
  attention: "text-attention",
  muted: "text-ink-3",
  ok: "text-ok",
};

export interface AgentCardProps extends Omit<ComponentProps<"article">, "children" | "title"> {
  name: string;
  description?: string | undefined;
  /** The mark: a lucide icon. */
  icon: ReactNode;
  /** The kind, above the name: "Built in", "Your agent". */
  eyebrow?: string | undefined;
  facts?: readonly AgentCardFact[] | undefined;
  /** Beside the name: the Default pill, a warning count. */
  badges?: ReactNode;
  /** The footer: buttons and links. Drawn only when given. */
  actions?: ReactNode;
  /** The body between facts and actions. */
  children?: ReactNode;
  /** Built-ins: the quieter ground of the page rather than a card. */
  quiet?: boolean | undefined;
}

export function AgentCard({ name, description, icon, eyebrow, facts, badges, actions, children, quiet = false, className, ...props }: AgentCardProps) {
  return (
    <article
      data-slot="agent-card"
      className={cn("flex w-full min-w-0 flex-col gap-3 rounded-xl p-4", quiet ? "bg-surface-2/60" : paper, className)}
      {...props}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
            quiet ? "bg-surface text-ink-2" : "bg-[color-mix(in_oklab,var(--live)_12%,var(--surface))] text-live",
          )}
        >
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold text-ink" title={name}>
              {name}
            </span>
            {badges}
          </span>
        </div>
      </div>

      {description ? <p className="text-sm leading-6 text-ink-2">{description}</p> : null}

      {facts && facts.length > 0 ? (
        <dl data-slot="agent-card-facts" className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="eyebrow self-baseline pt-px">{fact.label}</dt>
              <dd
                className={cn("min-w-0 truncate", fact.typed ? cn(mono, "tnum") : "text-sm", fact.tone ? FACT_TONE[fact.tone] : "text-ink-2")}
                title={fact.title ?? fact.value}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {children}

      {actions ? <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">{actions}</div> : null}
    </article>
  );
}
