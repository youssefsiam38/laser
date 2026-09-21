"use client";
/**
 * Directive text (`directive-text`, runtime-bound): the `Text` part renderer
 * for prompts and notices. Readable picker `@path` tokens and saved legacy
 * directives become chips; ordinary prose containing `@` stays text.
 */
import { type TextMessagePartComponent, type Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { AtSign, FileText, Folder } from "lucide-react";

import { projectMentionFormatter } from "../../thread/project-path.js";
import { WorkArtifactCard } from "../../project-work/ArtifactCard.js";
import { WorkMentionChip } from "../../project-work/MentionChip.js";
import { parseWorkMentionSegment } from "@/project-work/mentions";
import { createDirectiveText as createDirectiveTextBase, type CreateDirectiveTextOptions } from "./directive-text.js";

export type { CreateDirectiveTextOptions, DirectiveTextFormatter, DirectiveTextSegment } from "./directive-text.js";

/**
 * Project work in a transcript (M21-T9): an inline chip in a sentence, and a
 * compact card when the message *is* the reference — which is what a `/spec`
 * hand-off and a model tool's answer look like. Both open the workspace on
 * the exact revision the message pinned; neither ever shows a body.
 */
const renderWorkMention: NonNullable<CreateDirectiveTextOptions["renderMention"]> = (segment, alone) => {
  if (segment.type !== "work") return undefined;
  const parsed = parseWorkMentionSegment(segment.id);
  if (!parsed) return undefined;
  const title = segment.label === parsed.key ? undefined : segment.label;
  return alone ? (
    <WorkArtifactCard workKey={parsed.key} kind={parsed.kind} title={title} target={parsed.target} />
  ) : (
    <WorkMentionChip workKey={parsed.key} kind={parsed.kind} title={title} target={parsed.target} />
  );
};

const ICONS: CreateDirectiveTextOptions = {
  iconMap: { file: FileText, directory: Folder },
  fallbackIcon: AtSign,
  renderMention: renderWorkMention,
};

/** Creates a `Text` message part component that parses directive syntax and renders inline chips. */
export function createDirectiveText(formatter: Unstable_DirectiveFormatter, options: CreateDirectiveTextOptions = ICONS): TextMessagePartComponent {
  return createDirectiveTextBase(formatter, options);
}

/** Renders a plain transcript or notice string with path mentions. */
export const DirectiveString = createDirectiveTextBase(projectMentionFormatter, ICONS);
