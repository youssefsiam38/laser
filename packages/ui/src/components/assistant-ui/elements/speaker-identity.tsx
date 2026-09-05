"use client";
/**
 * Speaker identity (`elements-speaker-identity`): which agent produced a
 * message inside a child run — `orchestrator`, `worker#2`, a tool. Rendered
 * as a header above the message when the projection stamps a speaker
 * (`metadata.custom.laser.speaker`); the parent session's own replies carry
 * none and show none.
 *
 * Divergences from the registry copy: the registry renders a demo list of
 * turns; here one header is the component. Tones map to the app's status
 * colours — the agent is `--live`, everything else is ink.
 */
import { Bot, User, Wrench } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export type SpeakerKind = "user" | "agent" | "subagent" | "tool";

export interface Speaker {
  kind: SpeakerKind;
  name: string;
  /** Model, handle or role: "@auth-audit", "claude-sonnet". */
  detail?: string | undefined;
}

const TONE: Record<SpeakerKind, string> = {
  user: "bg-surface-2 text-ink-2",
  agent: "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live",
  subagent: "bg-surface-2 text-ink-2",
  tool: "bg-surface-2 text-ink-3",
};

export function SpeakerIdentity({ kind, name, detail, className, ...props }: Speaker & Omit<ComponentProps<"div">, "children">) {
  const Icon = kind === "user" ? User : kind === "tool" ? Wrench : Bot;
  return (
    <div data-slot="speaker-identity" data-kind={kind} className={cn("mb-1.5 flex min-w-0 items-center gap-2", className)} {...props}>
      <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center", kind === "subagent" ? "rounded-full" : "rounded-md", TONE[kind])}>
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 truncate text-sm font-medium text-ink">{name}</span>
      {detail ? <span className={cn(mono, "min-w-0 truncate text-ink-3")}>{detail}</span> : null}
    </div>
  );
}
