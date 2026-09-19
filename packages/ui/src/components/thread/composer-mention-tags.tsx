"use client";
/**
 * A chosen mention, in the draft, as one thing.
 *
 * The transcript chips a mention (`directive-text`), and until now the
 * composer that produced it showed the same choice as bare characters: the
 * person could not see that `@./server/index.ts` had stopped being something
 * they were typing. This paints the tag behind the text they are editing.
 *
 * The composer is a real `<textarea>` — it owns the caret, the selection,
 * dictation, IME and native undo, and none of that is worth trading for a
 * rich-text field. So the tag is drawn on a mirror layer *behind* the
 * textarea, with the same typography, padding and wrapping: it paints
 * backgrounds only, never glyphs (its own text is transparent), so no
 * character ever moves, the person's own text stays the only text on screen,
 * and selecting or copying yields the literal `@./server/index.ts`.
 *
 * Two consequences of that medium, both deliberate:
 *   - No icon inside the tag. An inline icon would need width, and width
 *     would move the person's characters out from under their own caret. The
 *     kind reads from the frame (a folder is drawn open, with a dashed edge)
 *     and from the path itself, which always ends in `/` for a folder.
 *   - Only *finished* mentions are tagged (`finished-mentions.ts`). While the
 *     picker is open on a query there is no tag, because nothing is chosen
 *     yet; the moment the person chooses, the words become one tag.
 */
import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentProps, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/utils";

import type { FinishedMentions, MentionKind } from "./finished-mentions.js";

/**
 * One tag. Tonal like the rest of the system (DESIGN.md "Colour"): a tint of
 * `--live` under a hairline of the same colour, so it reads as a tag in both
 * themes without inventing a colour. A folder's edge is dashed — a container
 * stays open — and a handle is filled a shade further, because it names
 * someone rather than something.
 */
const TAG_CLASS =
  "box-decoration-clone rounded-sm -mx-0.5 px-0.5 py-px outline-1 " +
  "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] outline-[color-mix(in_oklab,var(--live)_35%,transparent)]";
const KIND_CLASS: Record<MentionKind, string> = {
  file: "outline-solid",
  directory: "outline-dashed",
  agent: "outline-solid bg-[color-mix(in_oklab,var(--live)_18%,transparent)]",
};

/**
 * The layer itself. It subscribes to the draft on its own so the composer
 * around it does not re-render for a keystroke, and it renders nothing at all
 * until there is a finished mention to draw.
 */
export function ComposerMentionTags({
  mentions,
  field,
  className,
}: {
  mentions: FinishedMentions;
  /** The textarea this layer mirrors. The field owns it; the layer only reads it. */
  field: RefObject<HTMLTextAreaElement | null>;
  className?: string | undefined;
}) {
  const text = useAuiState((state) => state.composer.text);
  const tags = useMemo(() => mentions.advance(text), [mentions, text]);
  const layer = useRef<HTMLDivElement>(null);

  // The textarea scrolls once the draft outgrows it (`maxRows`), and it gives
  // up part of its width to the scrollbar when it does. The mirror has to
  // travel and narrow with it, or a tag comes loose from its word — wrapping
  // one word earlier is the worse of the two, because it moves every tag after
  // it.
  const follow = () => {
    const input = field.current;
    const mirror = layer.current;
    if (!input || !mirror) return;
    mirror.scrollTop = input.scrollTop;
    const style = getComputedStyle(input);
    const borders = (parseFloat(style.borderInlineStartWidth) || 0) + (parseFloat(style.borderInlineEndWidth) || 0);
    const gutter = Math.max(0, Math.round(input.offsetWidth - input.clientWidth - borders));
    mirror.style.marginInlineEnd = gutter ? `${gutter}px` : "";
  };
  useLayoutEffect(follow, [text, tags]);
  // This component stays mounted while it renders nothing, so the listener is
  // attached once for the composer's life — a composer opens empty and gains
  // its first tag much later, and a layer that only existed after the first
  // tag would never have been listening.
  useEffect(() => {
    const input = field.current;
    if (!input) return;
    input.addEventListener("scroll", follow);
    return () => input.removeEventListener("scroll", follow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `follow` reads live refs; the listener outlives every render
  }, [field]);

  if (tags.length === 0) return null;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [index, tag] of tags.entries()) {
    if (tag.start > at) parts.push(<span key={`text-${index}`}>{text.slice(at, tag.start)}</span>);
    parts.push(
      <span
        key={`tag-${index}`}
        data-slot="composer-mention-tag"
        data-mention-kind={tag.type}
        data-mention-label={tag.label}
        className={cn(TAG_CLASS, KIND_CLASS[tag.type])}
      >
        {tag.token}
      </span>,
    );
    at = tag.start + tag.token.length;
  }
  // A draft that ends in a newline keeps its empty last line in the textarea;
  // the mirror needs the same one so the two never drift apart.
  parts.push(<span key="rest">{text.slice(at)}{"\n"}</span>);
  return (
    <div
      ref={layer}
      aria-hidden
      dir="auto"
      data-slot="composer-mention-layer"
      className={cn(
        className,
        "pointer-events-none absolute inset-0 overflow-hidden text-transparent break-words whitespace-pre-wrap select-none",
        // A touch keyboard gets 16px inputs so iOS does not zoom (globals.css),
        // and that rule names `textarea`. The mirror has to grow with it or
        // every tag on a phone would sit beside its word rather than under it.
        "pointer-coarse:text-(length:--text-touch-min)",
      )}
    >
      {parts}
    </div>
  );
}

/**
 * The composer's text field with its tag layer behind it. `className` styles
 * the text itself and is shared by both, which is what keeps every glyph in
 * the same place on both layers.
 */
export function ComposerMentionField({
  mentions,
  className,
  wrapperClassName,
  ...input
}: { mentions: FinishedMentions; wrapperClassName?: string | undefined } & ComponentProps<typeof ComposerPrimitive.Input>) {
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    // `flex`, not a plain block: a textarea in normal flow is inline-level, and
    // an inline-level box leaves a baseline gap under itself. Every composer
    // this field replaced had the textarea as a flex item, and it stays one.
    <div data-slot="composer-mention-field" className={cn("relative flex min-w-0", wrapperClassName)}>
      <ComposerMentionTags mentions={mentions} field={field} className={className} />
      {/* Positioned, so the person's own text paints over the tags. */}
      <ComposerPrimitive.Input ref={field} {...input} className={cn(className, "relative min-w-0")} />
    </div>
  );
}
