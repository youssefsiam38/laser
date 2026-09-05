"use client";
/**
 * Directive text (`directive-text`, runtime-bound): the `Text` part renderer
 * for prompts and notices, using assistant-ui's default directive formatter
 * so `@file` mentions render as chips. Registry copy, unchanged apart from the
 * icon map for the mention types the composer produces.
 */
import { unstable_defaultDirectiveFormatter, type TextMessagePartComponent, type Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { AtSign, FileText } from "lucide-react";
import { memo } from "react";

import { createDirectiveText as createDirectiveTextBase, type CreateDirectiveTextOptions } from "./directive-text.js";

export type { CreateDirectiveTextOptions, DirectiveTextFormatter, DirectiveTextSegment } from "./directive-text.js";

const ICONS: CreateDirectiveTextOptions = {
  iconMap: { file: FileText, handle: AtSign },
  fallbackIcon: AtSign,
};

/** Creates a `Text` message part component that parses directive syntax and renders inline chips. */
export function createDirectiveText(formatter: Unstable_DirectiveFormatter, options: CreateDirectiveTextOptions = ICONS): TextMessagePartComponent {
  return createDirectiveTextBase(formatter, options);
}

/** `Text` message part component that renders directive syntax as inline chips. */
export const DirectiveText: TextMessagePartComponent = memo(createDirectiveTextBase(unstable_defaultDirectiveFormatter, ICONS));

/** The same renderer for a plain string outside a message part (a notice). */
export const DirectiveString = createDirectiveTextBase(unstable_defaultDirectiveFormatter, ICONS);
