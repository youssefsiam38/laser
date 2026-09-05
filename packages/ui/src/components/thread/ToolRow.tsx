import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  ChevronRight,
  CircleAlert,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  FolderSearch,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { memo, useMemo, useState, type ComponentType, type SVGProps } from "react";

import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { duration } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import { DialogBody, type DialogSpec } from "./DialogBody.js";
import { DiffBlock } from "./DiffBlock.js";
import { diffViewForTool } from "./diff.js";
import { TerminalBlock } from "./TerminalBlock.js";
import { useElapsed } from "./timing.js";
import {
  elideText,
  parseBashOutput,
  pretty,
  resultDetails,
  resultText,
  summarizeTool,
  toolBody,
  type ToolKind,
} from "./tool-summary.js";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ICONS: Record<ToolKind, Icon> = {
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: SquareTerminal,
  grep: Search,
  find: FolderSearch,
  ls: FolderOpen,
  other: Wrench,
};

/** Shape of `interrupt.payload` the projection builds for select/input/editor dialogs. */
interface InterruptPayload extends DialogSpec {
  readonly requestId: string;
}

const isInterruptPayload = (payload: unknown): payload is InterruptPayload => {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p["requestId"] === "string" && typeof p["title"] === "string" && typeof p["method"] === "string";
};

/**
 * One tool call: `[icon] verb  summary ····· duration`, expanding to the args
 * and result. bash → terminal block, edit/write → diff, everything else →
 * typed text. Errors get a `--danger` left hairline plus the error text
 * inline. A pending approval/interrupt renders as a non-modal footer.
 */
function ToolRowImpl(props: ToolCallMessagePartProps) {
  const { toolCallId, toolName, args, result, isError, status, approval, interrupt, timing } = props;
  const [open, setOpen] = useState(false);

  const summary = useMemo(() => summarizeTool(toolName, args), [toolName, args]);
  const kind = summary.kind;
  const running = status.type === "running";
  const awaiting = status.type === "requires-action";
  const failed = isError === true || (status.type === "incomplete" && status.reason !== "cancelled");
  const cancelled = status.type === "incomplete" && status.reason === "cancelled";
  const settled = !running && !awaiting;

  const localElapsed = useElapsed(toolCallId, running || awaiting ? "running" : settled ? "done" : "idle");
  const elapsed = timing ? (timing.completedAt ?? Date.now()) - timing.startedAt : localElapsed;

  const text = useMemo(() => resultText(result), [result]);
  const details = useMemo(() => resultDetails(result), [result]);
  const body = toolBody(kind);
  const hasBody = body !== "text" || text.length > 0 || (args !== undefined && Object.keys(args).length > 0);

  const Icon = ICONS[kind];
  // Only the first three non-blank lines are ever shown, so never split more
  // than a few KB of a megabyte-sized stderr.
  const errorExcerpt = useMemo(
    () => (failed && text ? firstLines(text.slice(0, 4096), 3) : undefined),
    [failed, text],
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="tool-row"
      data-tool={toolName}
      data-status={status.type}
      className={cn(
        "group/tool relative -mx-2 rounded-md px-2",
        failed && "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-danger",
        awaiting && "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-attention",
      )}
    >
      <CollapsibleTrigger asChild disabled={!hasBody}>
        <button
          type="button"
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none",
            "transition-colors duration-75 hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live",
            "disabled:cursor-default disabled:hover:bg-transparent",
          )}
          aria-label={`${summary.verb} ${summary.summary}`.trim()}
        >
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            {running ? (
              // The radar sweep is the one "working" motion in the system.
              <StatusDot status="working" size="sm" aria-hidden="true" />
            ) : failed ? (
              <CircleAlert className="size-3.5 text-danger" />
            ) : (
              <Icon className={cn("size-3.5", awaiting ? "text-attention" : "text-ink-3")} />
            )}
          </span>
          <span className={cn("shrink-0 text-sm font-medium", cancelled ? "text-ink-3 line-through" : "text-ink")}>
            {summary.verb}
          </span>
          {summary.summary ? (
            <span className={cn("typed min-w-0 truncate", cancelled ? "text-ink-3" : "text-ink-2")}>
              {summary.summary}
            </span>
          ) : null}
          {summary.detail ? <span className="typed shrink-0 text-ink-3">{summary.detail}</span> : null}
          <span
            aria-hidden="true"
            className="mt-px min-w-3 flex-1 self-center border-b border-dotted border-line transition-colors duration-75 group-hover/tool:border-ink-3"
          />
          {elapsed !== undefined ? (
            <span className={cn("typed shrink-0 tnum", running ? "text-live" : "text-ink-3")}>
              {duration(elapsed)}
            </span>
          ) : cancelled ? (
            <span className="typed shrink-0 text-ink-3">cancelled</span>
          ) : null}
          {hasBody ? (
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-ink-3",
                open && "rotate-90",
              )}
            />
          ) : (
            <span className="size-3.5 shrink-0" aria-hidden="true" />
          )}
        </button>
      </CollapsibleTrigger>

      {errorExcerpt && !open ? (
        <p className="typed mb-1.5 ms-6 whitespace-pre-wrap text-danger">{errorExcerpt}</p>
      ) : null}

      {hasBody ? (
        <CollapsibleContent>
          <div className="mb-2 ms-6 flex flex-col gap-2 pt-1">
            {body === "terminal" ? (
              <BashBody args={args} text={text} running={running} isError={failed} />
            ) : body === "diff" ? (
              <DiffBody kind={kind as "edit" | "write"} args={args} details={details} text={text} failed={failed} />
            ) : (
              <TextBody args={args} text={text} failed={failed} />
            )}
          </div>
        </CollapsibleContent>
      ) : null}

      {approval ? <ApprovalFooter {...props} approval={approval} /> : null}
      {interrupt && isInterruptPayload(interrupt.payload) ? (
        <InterruptFooter payload={interrupt.payload} resume={props.resume} />
      ) : null}
    </Collapsible>
  );
}

export const ToolRow = memo(ToolRowImpl);

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function firstLines(text: string, n: number): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const head = lines.slice(0, n).join("\n");
  return lines.length > n ? `${head}\n…` : head;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}

/**
 * Bounded output. `max-h-80 overflow-auto` bounds the painted box but not the
 * DOM, so the text is elided before it reaches it; "Show all" is the escape
 * hatch for the rare case where the tail is not enough.
 */
function TypedPre({ text, danger, className }: { text: string; danger?: boolean; className?: string }) {
  const [showAll, setShowAll] = useState(false);
  const elided = useMemo(() => elideText(text), [text]);
  return (
    <div className="flex flex-col gap-1">
      <pre
        className={cn(
          "max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-[18px] wrap-break-word whitespace-pre-wrap",
          danger ? "text-danger" : "text-ink-2",
          className,
        )}
      >
        {showAll ? text : elided.text}
      </pre>
      {elided.truncated && !showAll ? (
        <Button variant="link" size="xs" className="self-start text-xs" onClick={() => setShowAll(true)}>
          Show all ({elided.note} hidden)
        </Button>
      ) : null}
    </div>
  );
}

function ArgsList({ args }: { args: unknown }) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return <TypedPre text={pretty(args)} />;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs leading-[18px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 wrap-break-word whitespace-pre-wrap text-ink-2">
            {typeof v === "string" ? v : pretty(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BashBody({ args, text, running, isError }: { args: unknown; text: string; running: boolean; isError: boolean }) {
  const command = typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command : "";
  const { output, exitCode } = useMemo(() => parseBashOutput(text, isError), [text, isError]);
  return <TerminalBlock command={command} output={output} exitCode={exitCode} running={running} isError={isError} />;
}

function DiffBody({
  kind,
  args,
  details,
  text,
  failed,
}: {
  kind: "edit" | "write";
  args: unknown;
  details: Record<string, unknown> | undefined;
  text: string;
  failed: boolean;
}) {
  const view = useMemo(() => diffViewForTool(kind, args, details), [kind, args, details]);
  return (
    <>
      {view ? <DiffBlock view={view} /> : <Section label="args"><ArgsList args={args} /></Section>}
      {failed && text ? (
        <Section label="error">
          <TypedPre text={text} danger />
        </Section>
      ) : null}
    </>
  );
}

function TextBody({ args, text, failed }: { args: unknown; text: string; failed: boolean }) {
  return (
    <>
      <Section label="args">
        <ArgsList args={args} />
      </Section>
      {text ? (
        <Section label={failed ? "error" : "result"}>
          <TypedPre text={text} danger={failed} />
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Approval footer — "No" is never a dead end (DESIGN.md "Transcript")
// ---------------------------------------------------------------------------

function ApprovalFooter({
  approval,
  toolName,
  respondToApproval,
}: ToolCallMessagePartProps & { approval: NonNullable<ToolCallMessagePartProps["approval"]> }) {
  const { actions } = usePiorbitStable();
  const running = useAuiState((s) => s.thread.isRunning);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (approval.resolution || approval.approved !== undefined) {
    const label = approval.resolution === "expired" ? "Timed out" : approval.resolution === "cancelled" ? "Cancelled" : approval.approved ? "Allowed" : "Denied";
    return <p className="typed mb-1.5 ms-6 text-ink-3">{label}</p>;
  }

  const allow = async () => {
    setBusy(true);
    try {
      await respondToApproval({ approved: true });
    } finally {
      setBusy(false);
    }
  };

  const deny = async (feedback: string) => {
    setBusy(true);
    const trimmed = feedback.trim();
    try {
      if (trimmed) {
        // Delivered at the next turn boundary so the model sees why right after
        // the denied tool result; a follow-up would only land after the run.
        await actions.send([{ type: "text", text: `Denied: ${trimmed}` }], running ? "steer" : "prompt").catch(() => {});
      }
      await respondToApproval({ approved: false, ...(trimmed ? { reason: trimmed } : {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-slot="approval-footer"
      className="mb-2 ms-6 flex flex-col gap-2 border-s-2 border-attention py-1 ps-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && denying) {
          e.preventDefault();
          e.stopPropagation();
          setDenying(false);
        }
      }}
    >
      <p className="text-sm text-ink">{approval.prompt ?? `Allow ${toolName}?`}</p>
      {!denying ? (
        <div className="flex gap-2">
          <Button size="sm" autoFocus disabled={busy} onClick={() => void allow()}>
            Allow
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDenying(true)}>
            Deny
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            aria-label="Why not? Sent to the agent"
            placeholder="Tell the agent why (sent as “Denied: …”)"
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void deny(reason);
              }
            }}
            className="max-h-40 min-h-16"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void deny(reason)}>
              {reason.trim() ? "Send and deny" : "Deny"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDenying(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interrupt footer — select / input / editor raised while this tool runs
// ---------------------------------------------------------------------------

function InterruptFooter({ payload, resume }: { payload: InterruptPayload; resume: (payload: unknown) => void }) {
  return (
    <div data-slot="interrupt-footer" className="mb-2 ms-6 border-s-2 border-attention py-1 ps-3">
      <DialogBody
        variant="footer"
        dialog={payload}
        onValue={(value) => resume({ requestId: payload.requestId, value })}
        onConfirm={(confirmed) => resume({ requestId: payload.requestId, value: confirmed ? "yes" : "no" })}
        onCancel={() => resume({ requestId: payload.requestId, cancelled: true })}
      />
    </div>
  );
}
