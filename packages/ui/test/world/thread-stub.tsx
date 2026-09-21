/**
 * A light stand-in for `components/thread/Thread` in the bubble tests: the
 * same runtime seams (viewport, empty state, messages, composer input and
 * send) without markdown, highlighting, panels and the rest of the
 * transcript. What the tests exercise is the scope and the bubble around it.
 */
import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";

import { useLaserView } from "../../src/runtime/LaserProvider.js";

let renders = 0;
export const threadRenders = (): number => renders;
export const resetThreadRenders = (): void => {
  renders = 0;
};

export function ThreadStub({ emptyState }: { emptyState?: ReactNode; followUps?: unknown; statusSlot?: ReactNode }) {
  renders += 1;
  const view = useLaserView();
  return (
    <ThreadPrimitive.Root data-slot="thread">
      <span data-slot="thread-path">{view?.path ?? ""}</span>
      <ThreadPrimitive.Viewport data-slot="thread-viewport">
        <AuiIf condition={(s) => s.thread.isEmpty && !s.thread.isLoading}>{emptyState}</AuiIf>
        <div data-slot="thread-messages">
          <ThreadPrimitive.Messages>
            {() => (
              <MessagePrimitive.Root data-slot="message">
                <MessagePrimitive.Parts />
              </MessagePrimitive.Root>
            )}
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root data-slot="composer">
        <ComposerPrimitive.Input aria-label="Message" autoFocus submitMode="enter" />
        <ComposerPrimitive.Send data-slot="composer-send">Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
