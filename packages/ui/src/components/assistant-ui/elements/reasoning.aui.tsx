"use client";
/**
 * Reasoning (`reasoning`, runtime-bound): the collapsible "Reasoning · 3.2s"
 * block in the transcript. Streams open with the thinking indicator in the
 * header, stays expanded so the full reasoning remains visible, and never loses the reader's
 * place: the thread viewport is scroll-locked for the disclosure.
 *
 * Divergences from the registry copy:
 *   - Pi stamps no reasoning duration, so the elapsed time is our own wall
 *     clock (`useElapsed`), keyed on the message and the first part index so
 *     a row that unmounts and comes back keeps it.
 *   - `ReasoningGroup` targets `MessagePrimitive.GroupedParts` directly (the
 *     deprecated `components.ReasoningGroup` slot wrapper is gone).
 *   - The part renderer is our transcript `MarkdownText`, not a registry copy.
 */
import { useScrollLock, type ReasoningMessagePartComponent } from "@assistant-ui/react";
import { memo, useCallback, useRef, type ReactNode } from "react";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { useElapsed } from "@/components/thread/timing";
import { useActivityDetailLevel, useLaserState } from "@/runtime";

import {
  ReasoningContent,
  ReasoningFade,
  ReasoningRoot as ReasoningRootBase,
  ReasoningText,
  ReasoningTrigger,
  reasoningAnimationMs,
  type ReasoningRootProps,
} from "./reasoning.js";
import { ReasoningPanel } from "./reasoning-panel.js";

export type { ReasoningRootProps } from "./reasoning.js";

/** `ReasoningRoot` with the thread viewport scroll locked during disclosure animations. */
function ReasoningRoot({ ref, onAnimationStart, ...props }: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  const lockScroll = useScrollLock(collapsibleRef, reasoningAnimationMs());

  const handleAnimationStart = useCallback(() => {
    lockScroll();
    onAnimationStart?.();
  }, [lockScroll, onAnimationStart]);

  const composedRef = useCallback(
    (node: HTMLDivElement | null) => {
      collapsibleRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return <ReasoningRootBase ref={composedRef} onAnimationStart={handleAnimationStart} {...props} />;
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText className="text-sm text-ink-2" />;

const Reasoning = memo(ReasoningImpl) as unknown as ReasoningMessagePartComponent & {
  Root: typeof ReasoningRoot;
  Trigger: typeof ReasoningTrigger;
  Content: typeof ReasoningContent;
  Text: typeof ReasoningText;
  Fade: typeof ReasoningFade;
};
Reasoning.displayName = "Reasoning";
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;

export interface ReasoningGroupProps {
  /** Stable key for the wall-clock mark: `${messageId}:r${firstIndex}`. */
  timingKey: string;
  running: boolean;
  children: ReactNode;
}

/**
 * The `group-reasoning` node from `MessagePrimitive.GroupedParts`: header
 * while streaming is the thinking indicator, at rest "Reasoning · 3.2s".
 */
function ReasoningGroupImpl({ timingKey, running, children }: ReasoningGroupProps) {
  const elapsed = useElapsed(timingKey, running ? "running" : "done");
  const path = useLaserState((state) => state.current);
  const activityLevel = useActivityDetailLevel(path);
  return (
    <ReasoningRoot streaming={running} defaultOpen={activityLevel !== "answers"}>
      <ReasoningTrigger active={running} durationMs={elapsed} />
      <ReasoningPanel streaming={running}>{children}</ReasoningPanel>
    </ReasoningRoot>
  );
}
const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = "ReasoningGroup";

export { Reasoning, ReasoningGroup, ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText, ReasoningFade };
