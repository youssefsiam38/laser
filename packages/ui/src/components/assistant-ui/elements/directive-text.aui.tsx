"use client";
/**
 * Directive text (`directive-text`, runtime-bound): the `Text` part renderer
 * for prompts and notices. Readable picker `@path` tokens and saved legacy
 * directives become chips; ordinary prose containing `@` stays text.
 */
import { type TextMessagePartComponent, type Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { AtSign, FileText, Folder } from "lucide-react";
import { memo } from "react";

import { projectMentionFormatter } from "../../thread/project-path.js";
import { createDirectiveText as createDirectiveTextBase, type CreateDirectiveTextOptions } from "./directive-text.js";

export type { CreateDirectiveTextOptions, DirectiveTextFormatter, DirectiveTextSegment } from "./directive-text.js";

const ICONS: CreateDirectiveTextOptions = {
  iconMap: { file: FileText, directory: Folder, handle: AtSign },
  fallbackIcon: AtSign,
};

/** Creates a `Text` message part component that parses directive syntax and renders inline chips. */
export function createDirectiveText(formatter: Unstable_DirectiveFormatter, options: CreateDirectiveTextOptions = ICONS): TextMessagePartComponent {
  return createDirectiveTextBase(formatter, options);
}

/** `Text` message part component that renders directive syntax as inline chips. */
export const DirectiveText: TextMessagePartComponent = memo(createDirectiveTextBase(projectMentionFormatter, ICONS));

/** The same renderer for a plain string outside a message part (a notice). */
export const DirectiveString = createDirectiveTextBase(projectMentionFormatter, ICONS);
