import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import type { UiDialogRequest } from "@lasercode/protocol";
import { memo, useCallback, useMemo, useState } from "react";

import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";
import { ToolError } from "@/components/assistant-ui/elements/tool-error";
import {
  ToolFallback,
  ToolFallbackApproval,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackSection,
  toolRowState,
} from "@/components/assistant-ui/elements/tool-fallback.aui";
import { TOOL_ICONS } from "@/components/assistant-ui/elements/tool-group.aui";
import { useIsTouch } from "@/hooks/use-mobile";
import { DecisionBody, dialogPanel, PanelToolDecision, uiResponseFor, useRegisterToolRow } from "@/panels";
import { toolDetailsDefaultOpen, toolDisplayResult, useActivityDetailLevel, useLaserStable, useLaserState, type ActivityDetailLevel } from "@/runtime";
import { activeToolLabel } from "./tool-groups.js";
import { diffViewForTool } from "./diff.js";
import { useElapsed } from "./timing.js";
import { parseBashOutput, pretty, resultDetails, resultText, summarizeTool, toolBody } from "./tool-summary.js";

/** Shape of `interrupt.payload` the projection builds for select/input/editor dialogs. */
interface InterruptPayload {
  readonly requestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly title: string;
  readonly message?: string | undefined;
  readonly options?: readonly string[] | undefined;
  readonly placeholder?: string | undefined;
  readonly prefill?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const isInterruptPayload = (payload: unknown): payload is InterruptPayload => {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p["requestId"] === "string" && typeof p["title"] === "string" && typeof p["method"] === "string";
};

/**
 * One tool call in the transcript. This is the laser glue between Pi's
 * built-in tools and the catalog elements that draw them: `tool-call` is the
 * row, `terminal-block` the `bash` body, `code-diff` the `edit`/`write` body,
 * `tool-error` the failure, the `tool-fallback` parts the args, result and
 * approval, and `ToolFallback` itself the whole row for a tool we do not know.
 *
 * A decision that names this call renders inside the row (docs/ux-panels.md:
 * `decision × inline` is "in its tool row"), so the row registers itself
 * while it is on screen.
 */
function ToolRowImpl(props: ToolCallMessagePartProps) {
  const { toolCallId, toolName, args, isError, status, approval, interrupt, timing } = props;
  const result = toolDisplayResult(props);
  useRegisterToolRow(toolCallId);

  const summary = useMemo(() => summarizeTool(toolName, args), [toolName, args]);
  const kind = summary.kind;
  const state = toolRowState(status, isError);
  const running = state === "running";
  const awaiting = state === "awaiting";
  const failed = state === "failed";
  const isRequiresAction = status.type === "requires-action";
  const path = useLaserState((laser) => laser.current);
  const activityLevel = useActivityDetailLevel(path);

  // A decision starts open, but its always-visible footer does not prevent
  // the reader from folding the args/result above it.
  const [userOpen, setUserOpen] = useState<{ level: ActivityDetailLevel; open: boolean } | null>(null);
  const open = userOpen?.level === activityLevel ? userOpen.open : isRequiresAction || toolDetailsDefaultOpen(activityLevel);

  const localElapsed = useElapsed(toolCallId, running || awaiting ? "running" : "done");
  const elapsed = timing ? (timing.completedAt ?? Date.now()) - timing.startedAt : localElapsed;

  const text = useMemo(() => resultText(result), [result]);
  const details = useMemo(() => resultDetails(result), [result]);
  const footer = (
    <>
      {approval ? <RowApproval {...props} /> : null}
      {interrupt && isInterruptPayload(interrupt.payload) ? (
        <InterruptFooter payload={interrupt.payload} resume={props.resume} />
      ) : null}
      <PanelToolDecision toolCallId={toolCallId} />
    </>
  );

  // A tool Pi does not ship draws as the catalog's fallback row; the footer
  // it renders itself covers approvals, so only the declared decision is added.
  if (kind === "other") {
    return (
      <>
        <ToolFallback {...props} />
        <PanelToolDecision toolCallId={toolCallId} />
      </>
    );
  }

  const body = toolBody(kind);
  const hasBody = body !== "text" || text.length > 0 || (args !== undefined && Object.keys(args as object).length > 0);

  return (
    <ToolCall
      icon={TOOL_ICONS[kind]}
      verb={summary.verb}
      activeLabel={activeToolLabel({ toolName, args })}
      summary={summary.summary}
      detail={summary.detail}
      state={state}
      elapsedMs={elapsed}
      open={open}
      onOpenChange={(next) => setUserOpen({ level: activityLevel, open: next })}
      toolName={toolName}
      peek={failed && text ? <ToolError message={text} compact /> : undefined}
      footer={footer}
    >
      {hasBody ? (
        body === "terminal" ? (
          <BashBody args={args} text={text} running={running} isError={failed} />
        ) : body === "diff" ? (
          <DiffBody kind={kind as "edit" | "write"} args={args} details={details} text={text} failed={failed} />
        ) : (
          <TextBody args={args} text={text} failed={failed} />
        )
      ) : undefined}
    </ToolCall>
  );
}

export const ToolRow = memo(ToolRowImpl);

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

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
      {view ? <CodeDiff view={view} /> : <ToolFallbackArgs argsText={pretty(args)} />}
      {failed && text ? (
        <ToolFallbackSection label="error">
          <ToolError message={text} />
        </ToolFallbackSection>
      ) : null}
    </>
  );
}

function TextBody({ args, text, failed }: { args: unknown; text: string; failed: boolean }) {
  return (
    <>
      <ToolFallbackArgs argsText={pretty(args)} />
      {text ? (
        failed ? (
          <ToolFallbackSection label="error">
            <ToolError message={text} />
          </ToolFallbackSection>
        ) : (
          <ToolFallbackResult result={text} />
        )
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Approval — "No" is never a dead end (DESIGN.md "Transcript")
// ---------------------------------------------------------------------------

/**
 * The catalog's approval part, with the denial's reason delivered to the
 * agent at the next turn boundary (`steer` while running, a prompt otherwise)
 * so the model reads why right after the refused tool result.
 */
function RowApproval(props: ToolCallMessagePartProps) {
  const { actions } = useLaserStable();
  const running = useAuiState((s) => s.thread.isRunning);
  const denyFeedback = useCallback(
    async (reason: string) => {
      await actions.send([{ type: "text", text: `Denied: ${reason}` }], running ? "steer" : "prompt").catch(() => {});
    },
    [actions, running],
  );
  return (
    <ToolFallbackApproval
      approval={props.approval}
      interrupt={props.interrupt}
      status={props.status}
      addResult={props.addResult}
      resume={props.resume}
      respondToApproval={props.respondToApproval}
      denyFeedback={denyFeedback}
    />
  );
}

// ---------------------------------------------------------------------------
// Interrupt footer — select / input / editor raised while this tool runs
// ---------------------------------------------------------------------------

/**
 * A question raised while exactly one tool runs renders inside that tool's row
 * (docs/ux-panels.md: `decision` × `blocking: "tool"`). It is the same
 * `DecisionBody` as the card above the composer and the session-blocking
 * sheet — one renderer, so a question never looks like two different things
 * depending on where it happened to be asked.
 *
 * It answers through assistant-ui's `resume` rather than the panel store,
 * because the payload reached this row through the tool call, not the panel
 * stream — the store deliberately leaves a dialog alone once its tool row has
 * it (`fallbackPanels`).
 */
function InterruptFooter({ payload, resume }: { payload: InterruptPayload; resume: (payload: unknown) => void }) {
  const panel = useMemo(
    () =>
      dialogPanel(
        {
          id: payload.requestId,
          method: payload.method,
          title: payload.title,
          ...(payload.message !== undefined ? { message: payload.message } : {}),
          ...(payload.options !== undefined ? { options: [...payload.options] } : {}),
          ...(payload.placeholder !== undefined ? { placeholder: payload.placeholder } : {}),
          ...(payload.prefill !== undefined ? { prefill: payload.prefill } : {}),
          ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
        } as UiDialogRequest,
        false,
      ),
    [payload],
  );
  const touch = useIsTouch();
  return (
    <div data-slot="interrupt-footer" className="mb-2 ms-6 border-s-2 border-attention py-1 ps-3">
      <DecisionBody
        panel={panel}
        touch={touch}
        onAnswer={async (values: Record<string, string | boolean> | undefined) => {
          const response = uiResponseFor(payload.requestId, payload.method, values);
          if ("cancelled" in response) resume({ requestId: payload.requestId, cancelled: true });
          else if ("confirmed" in response) resume({ requestId: payload.requestId, value: response.confirmed ? "yes" : "no" });
          else resume({ requestId: payload.requestId, value: response.value });
        }}
      />
    </div>
  );
}
