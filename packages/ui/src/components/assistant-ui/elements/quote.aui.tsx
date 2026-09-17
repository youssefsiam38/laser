"use client";
/**
 * Quote (`quote`): quote deliberately selected transcript text into the
 * composer. Three pieces — a keyboard action that leaves native selection
 * alone until invoked, the preview inside the composer card, and `QuoteBlock`
 * for a quote carried on a sent message.
 *
 * Pi's prompt is plain text, so the composer folds the quote into the message
 * as a markdown blockquote when it sends (`Composer.tsx`); `quote-reply`
 * renders that blockquote back on the sent message.
 *
 * Divergences from the registry copy: the floating `SelectionToolbarPrimitive`
 * is deliberately not mounted. It listens to every mouseup/keyup/selection
 * collapse and covers ordinary browser selection with a custom popup. Native
 * word/paragraph/drag selection and the native context menu win instead.
 * Quoting remains available through Ctrl/Cmd+Shift+Q while one message owns
 * the selection. Dismiss is a `TooltipIconButton`; all styling uses tokens.
 */
import { ComposerPrimitive, useAui, type QuoteMessagePartComponent } from "@assistant-ui/react";
import { Quote as QuoteIcon, X } from "lucide-react";
import { memo, useEffect, type ComponentProps, type FC, type RefObject } from "react";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// QuoteBlock — a quote on a sent message
// ---------------------------------------------------------------------------

function QuoteBlockRoot({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="quote-block" className={cn("mb-2 flex items-start gap-1.5", className)} {...props} />;
}

function QuoteBlockIcon({ className, ...props }: ComponentProps<typeof QuoteIcon>) {
  return <QuoteIcon aria-hidden="true" data-slot="quote-block-icon" className={cn("mt-0.5 size-3 shrink-0 text-ink-3", className)} {...props} />;
}

function QuoteBlockText({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="quote-block-text" className={cn("line-clamp-2 min-w-0 text-sm text-ink-2 italic", className)} {...props} />;
}

const QuoteBlockImpl: QuoteMessagePartComponent = ({ text }) => (
  <QuoteBlockRoot>
    <QuoteBlockIcon />
    <QuoteBlockText>{text}</QuoteBlockText>
  </QuoteBlockRoot>
);

const QuoteBlock = memo(QuoteBlockImpl) as unknown as QuoteMessagePartComponent & {
  Root: typeof QuoteBlockRoot;
  Icon: typeof QuoteBlockIcon;
  Text: typeof QuoteBlockText;
};
QuoteBlock.displayName = "QuoteBlock";
QuoteBlock.Root = QuoteBlockRoot;
QuoteBlock.Icon = QuoteBlockIcon;
QuoteBlock.Text = QuoteBlockText;

// ---------------------------------------------------------------------------
// TranscriptQuoteShortcut — deliberate quote without a selection popup
// ---------------------------------------------------------------------------

export interface TranscriptSelectionQuote {
  text: string;
  messageId: string;
}

const nodeElement = (node: Node | null): Element | null =>
  node instanceof Element ? node : node?.parentElement ?? null;

/**
 * Returns a quote only when both ends of the browser selection belong to the
 * same message in this thread. A cross-message selection stays ordinary page
 * text and never becomes a misleading single-message quote.
 */
export function transcriptSelectionQuote(
  selection: Selection | null,
  thread: HTMLElement | null,
): TranscriptSelectionQuote | undefined {
  if (!selection || selection.isCollapsed || !thread) return undefined;
  const anchor = nodeElement(selection.anchorNode)?.closest<HTMLElement>("[data-message-id]");
  const focus = nodeElement(selection.focusNode)?.closest<HTMLElement>("[data-message-id]");
  if (!anchor || anchor !== focus || !thread.contains(anchor)) return undefined;
  const text = selection.toString().trim();
  const messageId = anchor.dataset.messageId;
  return text && messageId ? { text, messageId } : undefined;
}

export function TranscriptQuoteShortcut({ thread }: { thread: RefObject<HTMLElement | null> }) {
  const aui = useAui();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.key.toLowerCase() !== "q"
      ) return;
      const selection = window.getSelection();
      const quote = transcriptSelectionQuote(selection, thread.current);
      if (!quote) return;
      event.preventDefault();
      aui.thread.composer().setQuote(quote);
      selection?.removeAllRanges();
      thread.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [aui, thread]);
  return null;
}

// ---------------------------------------------------------------------------
// ComposerQuotePreview — inside the composer card, only while a quote is set
// ---------------------------------------------------------------------------

function ComposerQuotePreviewRoot({ className, ...props }: ComponentProps<typeof ComposerPrimitive.Quote>) {
  return (
    <ComposerPrimitive.Quote
      data-slot="composer-quote"
      className={cn("mx-3 mt-3 flex items-start gap-2 rounded-lg border-s-2 border-live bg-surface-2 py-1.5 pe-1.5 ps-3", className)}
      {...props}
    />
  );
}

function ComposerQuotePreviewIcon({ className, ...props }: ComponentProps<typeof QuoteIcon>) {
  return <QuoteIcon aria-hidden="true" data-slot="composer-quote-icon" className={cn("mt-0.5 size-3.5 shrink-0 text-ink-3", className)} {...props} />;
}

function ComposerQuotePreviewText({ className, ...props }: ComponentProps<typeof ComposerPrimitive.QuoteText>) {
  return <ComposerPrimitive.QuoteText data-slot="composer-quote-text" className={cn("line-clamp-2 min-w-0 flex-1 text-sm text-ink-2", className)} {...props} />;
}

function ComposerQuotePreviewDismiss({ className, ...props }: ComponentProps<typeof ComposerPrimitive.QuoteDismiss>) {
  return (
    <ComposerPrimitive.QuoteDismiss asChild {...props}>
      <TooltipIconButton tooltip="Remove quote" size="icon-xs" side="top" className={cn("text-ink-3", className)}>
        <X />
      </TooltipIconButton>
    </ComposerPrimitive.QuoteDismiss>
  );
}

const ComposerQuotePreviewImpl: FC<ComponentProps<typeof ComposerQuotePreviewRoot>> = ({ className, ...props }) => (
  <ComposerQuotePreviewRoot className={className} {...props}>
    <ComposerQuotePreviewIcon />
    <ComposerQuotePreviewText />
    <ComposerQuotePreviewDismiss />
  </ComposerQuotePreviewRoot>
);

const ComposerQuotePreview = memo(ComposerQuotePreviewImpl) as unknown as typeof ComposerQuotePreviewImpl & {
  Root: typeof ComposerQuotePreviewRoot;
  Icon: typeof ComposerQuotePreviewIcon;
  Text: typeof ComposerQuotePreviewText;
  Dismiss: typeof ComposerQuotePreviewDismiss;
};
ComposerQuotePreview.displayName = "ComposerQuotePreview";
ComposerQuotePreview.Root = ComposerQuotePreviewRoot;
ComposerQuotePreview.Icon = ComposerQuotePreviewIcon;
ComposerQuotePreview.Text = ComposerQuotePreviewText;
ComposerQuotePreview.Dismiss = ComposerQuotePreviewDismiss;

/** `> line` blockquote text for a quote folded into a plain-text prompt. */
export function quoteAsMarkdown(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export {
  QuoteBlock,
  QuoteBlockRoot,
  QuoteBlockIcon,
  QuoteBlockText,
  ComposerQuotePreview,
  ComposerQuotePreviewRoot,
  ComposerQuotePreviewIcon,
  ComposerQuotePreviewText,
  ComposerQuotePreviewDismiss,
};
