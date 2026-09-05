import {
  ActionBarPrimitive,
  AuiIf,
  MessagePrimitive,
  groupPartByType,
  useAuiState,
  type MessageState,
} from "@assistant-ui/react";
import { Check, ChevronRight, CircleAlert, Copy, Image, Info, TriangleAlert } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { duration } from "@/format";
import { cn } from "@/lib/utils";
import { NOTICE_DATA_PART } from "@/runtime";
import { MarkdownText } from "./MarkdownText.js";
import { useElapsed } from "./timing.js";
import { ToolRow } from "./ToolRow.js";

/** `metadata.custom.piorbit` the projection stamps on every message. */
interface PiorbitMeta {
  kind?: "user" | "turn" | "notice";
  images?: number;
  optimistic?: boolean;
  level?: "info" | "warning" | "error";
}

const piorbitMeta = (message: MessageState): PiorbitMeta =>
  ((message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom?.["piorbit"] as PiorbitMeta | undefined) ?? {};

const MESSAGE_ROOT = "[content-visibility:auto] [contain-intrinsic-size:auto_320px]";

/** Chooser: assistant-ui's `ThreadPrimitive.Messages` render function target. */
export function ThreadMessage() {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export function UserMessage() {
  const text = useAuiState((s) => {
    const first = s.message.parts.find((p) => p.type === "text");
    return first && first.type === "text" ? first.text : "";
  });
  const images = useAuiState((s) => piorbitMeta(s.message).images ?? 0);
  const optimistic = useAuiState((s) => piorbitMeta(s.message).optimistic === true);

  return (
    <MessagePrimitive.Root
      data-role="user"
      className={cn("group/message flex justify-end", MESSAGE_ROOT)}
    >
      <div className="flex max-w-[85%] items-end gap-1">
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="always"
          className="mb-1 flex opacity-0 transition-opacity duration-75 group-hover/message:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <ActionBarPrimitive.Copy asChild>
            <TooltipIconButton tooltip="Copy" size="icon-xs" className="text-ink-3">
              <AuiIf condition={(s) => s.message.isCopied}>
                <Check className="text-ok" />
              </AuiIf>
              <AuiIf condition={(s) => !s.message.isCopied}>
                <Copy />
              </AuiIf>
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
        <div
          data-optimistic={optimistic || undefined}
          className={cn(
            "flex min-w-0 flex-col gap-2 rounded-[10px] bg-surface-2 px-4 py-2.5 text-md text-ink",
            optimistic && "opacity-70",
          )}
        >
          {text ? <p className="wrap-break-word whitespace-pre-wrap">{text}</p> : null}
          {images > 0 ? (
            <Badge variant="outline" className="self-end">
              <Image aria-hidden="true" />
              <span className="tnum">{images}</span> {images === 1 ? "image" : "images"}
            </Badge>
          ) : null}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

const groupBy = groupPartByType({
  reasoning: ["group-reasoning"],
  "tool-call": ["group-tool"],
  "standalone-tool-call": [],
});

export function AssistantMessage() {
  const streaming = useAuiState((s) => s.message.role === "assistant" && s.message.status.type === "running");
  const isNotice = useAuiState((s) => piorbitMeta(s.message).kind === "notice");
  const messageId = useAuiState((s) => s.message.id);

  return (
    <MessagePrimitive.Root
      data-role="assistant"
      data-streaming={streaming || undefined}
      className={cn(
        "group/message relative flex flex-col",
        "before:absolute before:inset-y-0 before:-start-3 before:w-0.5 before:rounded-full before:bg-live before:opacity-0 md:before:-start-4",
        streaming && "before:opacity-100",
        MESSAGE_ROOT,
      )}
    >
      <MessagePrimitive.GroupedParts groupBy={groupBy}>
        {({ part, children }) => {
          switch (part.type) {
            case "group-reasoning":
              return (
                <ReasoningGroup
                  timingKey={`${messageId}:r${part.indices[0] ?? 0}`}
                  running={part.status.type === "running"}
                >
                  {children}
                </ReasoningGroup>
              );
            case "group-tool":
              return <div className="my-2 flex flex-col first:mt-0 last:mb-0">{children}</div>;
            case "text":
              return (
                <div className="my-3 first:mt-0 last:mb-0">
                  <MarkdownText />
                </div>
              );
            case "reasoning":
              return <MarkdownText className="text-sm text-ink-2" />;
            case "tool-call":
              return part.toolUI ?? <ToolRow {...part} />;
            case "data":
              if (part.name === NOTICE_DATA_PART) return <Notice data={part.data} />;
              return part.dataRendererUI;
            case "indicator":
              return (
                <span role="status" aria-label="Working" className="caret inline-block h-6 text-md" />
              );
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
      {!isNotice ? <AssistantActionBar /> : null}
    </MessagePrimitive.Root>
  );
}

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="-ms-1.5 mt-1 flex h-7 items-center opacity-0 transition-opacity duration-75 group-hover/message:opacity-100 focus-within:opacity-100 data-[floating]:opacity-100 [@media(pointer:coarse)]:opacity-100"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" size="icon-xs" className="text-ink-3">
          <AuiIf condition={(s) => s.message.isCopied}>
            <Check className="text-ok" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <Copy />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Reasoning group: "Reasoning · 3.2s", shimmering while streaming, collapsed
// by default once complete.
// ---------------------------------------------------------------------------

function ReasoningGroup({ timingKey, running, children }: { timingKey: string; running: boolean; children: ReactNode }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const elapsed = useElapsed(timingKey, running ? "running" : "done");
  const open = userOpen ?? running;

  return (
    <Collapsible
      open={open}
      onOpenChange={setUserOpen}
      data-slot="reasoning"
      data-streaming={running || undefined}
      className="my-2 first:mt-0"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group/reasoning -mx-2 flex h-7 items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors duration-75 hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-ink-3",
              open && "rotate-90",
            )}
          />
          <span className={cn("font-medium", running ? "shimmer-text" : "text-ink-2")}>Reasoning</span>
          {elapsed !== undefined ? (
            <span className="typed tnum text-ink-3">
              <span aria-hidden="true">· </span>
              {duration(elapsed)}
            </span>
          ) : null}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ms-[7px] flex max-h-80 flex-col gap-3 overflow-y-auto border-s border-line py-1 ps-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Notices: compaction, auto-retry, extension errors (`data` part)
// ---------------------------------------------------------------------------

const NoticeImpl = ({ data }: { data: unknown }) => {
  const { level, text } = (data as { level?: string; text?: string } | undefined) ?? {};
  const tone = level === "error" ? "danger" : level === "warning" ? "attention" : "info";
  const Icon = tone === "danger" ? CircleAlert : tone === "attention" ? TriangleAlert : Info;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-level={level}
      className={cn(
        "my-1 flex items-start gap-2 text-sm",
        tone === "danger" ? "text-danger" : tone === "attention" ? "text-attention" : "text-ink-2",
      )}
    >
      <Icon aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0 wrap-break-word whitespace-pre-wrap">{text ?? ""}</span>
    </div>
  );
};

export const Notice = memo(NoticeImpl);
