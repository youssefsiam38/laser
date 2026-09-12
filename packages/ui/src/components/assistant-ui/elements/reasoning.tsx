"use client";
import { useSearchReveal } from "@/components/thread/search-state";
/**
 * Reasoning (`reasoning`, the composable half): Root, Trigger, Content, Text
 * and Fade for the assistant's thinking block. `reasoning.aui.tsx` binds them
 * to the runtime; `reasoning-panel.tsx` is the body.
 *
 * Divergences from the registry copy, each on purpose:
 *   - The disclosure animates through Radix's collapsible keyframes on the
 *     `--motion-fast` token (`reasoningAnimationMs()` reads it, so the scroll
 *     lock in `reasoning.aui` uses the same number the CSS does).
 *   - No brain icon; the row is `[chevron] Reasoning · 3.2s`, as DESIGN.md
 *     draws it. While streaming the label is the thinking indicator.
 *   - The `outline` and `muted` variants are gone: the block sits on the
 *     ground with a hairline, like a tool group, not in a card.
 *   - Fades use `--bg`; no blur; every duration is a token.
 */
import { ChevronRight } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { duration as formatDuration } from "@/format";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";
import { useActivityDisclosureOverride } from "@/runtime/sessionPreferences";

import { ThinkingIndicator } from "./thinking-indicator.js";

/** How long the disclosure takes, from the token, at call time. */
export function reasoningAnimationMs(): number {
  return motionMs("--motion-fast");
}

const ReasoningPreviewContext = createContext(false);

export type ReasoningRootProps = Omit<ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /** While `true`, an already-open disclosure keeps its bottom-pinned live preview. */
  streaming?: boolean;
  /** Optional stable scope for remembering a manual choice across remounts. */
  sessionPath?: string;
  disclosureId?: string;
  /** Called right before the disclosure animates on a manual toggle. */
  onAnimationStart?: () => void;
};

function ReasoningRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  sessionPath,
  disclosureId,
  onAnimationStart,
  children,
  ...props
}: ReasoningRootProps) {
  const initialOpenRef = useRef(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [rememberedOpen, rememberOpen] = useActivityDisclosureOverride(sessionPath, disclosureId);
  const hasDurableIdentity = Boolean(sessionPath && disclosureId);
  const manualOpen = hasDurableIdentity ? rememberedOpen : userOpen;
  if (manualOpen === null || manualOpen === undefined) initialOpenRef.current = defaultOpen;

  const isControlled = controlledOpen !== undefined;
  const reveal = useSearchReveal();
  const isOpen = reveal || (isControlled ? controlledOpen : (manualOpen ?? initialOpenRef.current));
  const isPreview = streaming === true && isOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      onAnimationStart?.();
      if (!isControlled) {
        if (!hasDurableIdentity) setUserOpen(open);
        rememberOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [onAnimationStart, isControlled, hasDurableIdentity, rememberOpen, controlledOnOpenChange],
  );

  return (
    <Collapsible
      data-slot="reasoning-root"
      data-streaming={streaming || undefined}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("group/reasoning-root my-2 w-full first:mt-0", className)}
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>{children}</ReasoningPreviewContext.Provider>
    </Collapsible>
  );
}

function ReasoningFade({ side = "bottom", className, ...props }: ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  return (
    <div
      data-slot="reasoning-fade"
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-6",
        side === "top" ? "top-0 bg-[linear-gradient(to_bottom,var(--bg),transparent)]" : "bottom-0 bg-[linear-gradient(to_top,var(--bg),transparent)]",
        className,
      )}
      {...props}
    />
  );
}

export interface ReasoningTriggerProps extends ComponentProps<typeof CollapsibleTrigger> {
  /** Streaming: the label shimmers and the dot sweeps. */
  active?: boolean;
  /** Elapsed milliseconds; ticking while active, frozen once done. */
  durationMs?: number | undefined;
  label?: string;
}

function ReasoningTrigger({ active = false, durationMs, label = "Reasoning", className, children, ...props }: ReasoningTriggerProps) {
  const elapsed = durationMs !== undefined ? formatDuration(durationMs) : undefined;
  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "group/trigger -mx-2 flex h-7 max-w-full items-center gap-2 rounded-md px-2 text-start text-sm outline-none",
        "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        className,
      )}
      {...props}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn("rtl:-scale-x-100",
          "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) ease-morph motion-reduce:transition-none",
          "group-data-[state=open]/trigger:rotate-90 group-data-[state=open]/trigger:rtl:-rotate-90",
        )}
      />
      {children ??
        (active ? (
          <ThinkingIndicator label={label} elapsed={elapsed} dot={false} />
        ) : (
          <>
            <span className="font-medium text-ink-2">{label}</span>
            {elapsed !== undefined ? (
              <span className="typed text-ink-3 tnum">
                <span aria-hidden="true">· </span>
                {elapsed}
              </span>
            ) : null}
          </>
        ))}
    </CollapsibleTrigger>
  );
}

function ReasoningContent({ className, children, ...props }: ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);
  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "relative overflow-hidden text-sm text-ink-2 outline-none",
        "duration-(--motion-fast) ease-morph data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}

/**
 * The scrolling body. While the block streams it pins to the newest line
 * and lets go the moment the reader scrolls up.
 */
function ReasoningText({ className, children, style, ...props }: ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl || typeof ResizeObserver === "undefined") return;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;
    const pin = () => {
      if (pinned) scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    // A pin's own scroll event can arrive after new content grew the scroll
    // height and read as "not at bottom"; only an upward move at unchanged
    // scroll height is the reader's intent.
    const onScroll = () => {
      if (isAtBottom()) pinned = true;
      else if (scrollEl.scrollTop < lastScrollTop && scrollEl.scrollHeight === lastScrollHeight) pinned = false;
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn("relative z-0 ms-[7px] max-h-64 overflow-y-auto border-s border-line py-1 ps-4", className)}
      style={style as CSSProperties}
      {...props}
    >
      <div ref={contentRef} className="flex flex-col gap-3">
        {children}
      </div>
    </div>
  );
}

export { ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText, ReasoningFade };
