"use client";
/**
 * Quote (`quote`): select transcript text, quote it into the composer. Three
 * pieces — the floating selection toolbar over the thread, the preview inside
 * the composer card, and `QuoteBlock` for a quote carried on a sent message.
 *
 * Pi's prompt is plain text, so the composer folds the quote into the message
 * as a markdown blockquote when it sends (`Composer.tsx`); `quote-reply`
 * renders that blockquote back on the sent message.
 *
 * Divergences from the registry copy: tokens only (`floating`, `--ink-3`,
 * `--surface-2`), the toolbar button is a `Button`, dismiss is a
 * `TooltipIconButton`, motion reads the tokens.
 */
import { ComposerPrimitive, SelectionToolbarPrimitive, type QuoteMessagePartComponent } from "@assistant-ui/react";
import { Quote as QuoteIcon, X } from "lucide-react";
import { memo, type ComponentProps, type FC } from "react";

import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { floating } from "./surfaces.js";

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
// SelectionToolbar — appears over selected transcript text
// ---------------------------------------------------------------------------

function SelectionToolbarRoot({ className, ...props }: ComponentProps<typeof SelectionToolbarPrimitive.Root>) {
  return (
    <SelectionToolbarPrimitive.Root
      data-slot="selection-toolbar"
      className={cn(
        floating,
        "z-50 flex items-center gap-0.5 rounded-lg p-1",
        "animate-in fade-in-0 zoom-in-95 duration-(--motion-fast) motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

function SelectionToolbarQuote({ className, children, ...props }: ComponentProps<typeof SelectionToolbarPrimitive.Quote>) {
  return (
    <SelectionToolbarPrimitive.Quote asChild {...props}>
      <Button variant="ghost" size="sm" className={cn("gap-1.5", className)}>
        {children ?? (
          <>
            <QuoteIcon />
            Quote
          </>
        )}
      </Button>
    </SelectionToolbarPrimitive.Quote>
  );
}

const SelectionToolbarImpl: FC<ComponentProps<typeof SelectionToolbarRoot>> = ({ className, ...props }) => (
  <SelectionToolbarRoot className={className} {...props}>
    <SelectionToolbarQuote />
  </SelectionToolbarRoot>
);

const SelectionToolbar = memo(SelectionToolbarImpl) as unknown as typeof SelectionToolbarImpl & {
  Root: typeof SelectionToolbarRoot;
  Quote: typeof SelectionToolbarQuote;
};
SelectionToolbar.displayName = "SelectionToolbar";
SelectionToolbar.Root = SelectionToolbarRoot;
SelectionToolbar.Quote = SelectionToolbarQuote;

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
  SelectionToolbar,
  SelectionToolbarRoot,
  SelectionToolbarQuote,
  ComposerQuotePreview,
  ComposerQuotePreviewRoot,
  ComposerQuotePreviewIcon,
  ComposerQuotePreviewText,
  ComposerQuotePreviewDismiss,
};
