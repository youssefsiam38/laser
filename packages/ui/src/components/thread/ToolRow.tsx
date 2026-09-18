import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import { toolDisplayLabel, toolSearchContent, withoutToolLabel, type UiDialogRequest } from "@lasercode/protocol";
import { Bot, FolderOpen, GitBranch, MessageSquare } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useMemo, type ReactNode } from "react";

import { useSessionMcpServers } from "@/agents/hooks";
import { CodeDiff, DiffStat, diffStatDescription } from "@/components/assistant-ui/elements/code-diff";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { ToolCall, ToolSearchBodyContext } from "@/components/assistant-ui/elements/tool-call";
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
import { CapabilityNotice } from "@/components/capability-gate";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useIsTouch } from "@/hooks/use-mobile";
import { DialogBody, dialogFormOf, ToolRowDialog, uiResponseFor, useRegisterToolRow } from "@/dialogs";
import { toolDetailsDefaultOpen, toolDisplayResult, useActivityDetailLevel, useCapability, useLaserStable, useLaserState } from "@/runtime";
import { BodyOverflow, type FoldGround } from "./BodyOverflow.js";
import type { OutputContext } from "./LargeBodyViewer.js";
import { omittedBytes } from "@/runtime/body-excerpt";
import { useOutputPreview } from "./output-preview.js";
import type { BlockBodies } from "@/store";
import { useActivityDisclosureOverride } from "@/runtime/sessionPreferences";
import { FileCard } from "./FileCard.js";
import { activeToolLabel } from "./tool-groups.js";
import { classifyMcpTool } from "./mcp-tools.js";
import { McpToolRow } from "./McpToolRow.js";
import { diffStats, diffViewForTool } from "./diff.js";
import { useElapsed } from "./timing.js";
import { isNonZeroExit, parseBashOutput, pretty, resultDetails, resultText, summarizeTool, toolBody } from "./tool-summary.js";

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

const ToolSourceCode = lazy(() =>
  import("@/components/assistant-ui/elements/tool-code-highlights").then((module) => ({ default: module.ToolSourceCode })),
);

/**
 * One tool call in the transcript. This is the laser glue between Pi's
 * built-in tools and the catalog elements that draw them: `tool-call` is the
 * row, `terminal-block` the `bash` body, `code-diff` the `edit`/`write` body,
 * `tool-error` the failure, the `tool-fallback` parts the args, result and
 * approval, and `ToolFallback` itself the whole row for a tool we do not know.
 *
 * A question that names this call renders inside the row (docs/ux-fleet.md,
 * "Questions"), so the row registers itself while it is on screen.
 */
function ToolRowImpl(props: ToolCallMessagePartProps) {
  const { toolCallId, toolName, args, argsText, isError, status, approval, interrupt, timing } = props;
  const result = toolDisplayResult(props);
  useRegisterToolRow(toolCallId);

  const summary = useMemo(() => summarizeTool(toolName, args), [toolName, args]);
  const kind = summary.kind;
  const heldText = useMemo(() => resultText(result), [result]);
  // A shell command that ran and came back non-zero is a result, not a failure
  // of the app: the row stays ordinary and only the command turns
  // (`isNonZeroExit`, tool-summary.ts).
  const state = toolRowState(status, isError, isNonZeroExit(toolName, isError === true, heldText));
  const running = state === "running";
  const awaiting = state === "awaiting";
  const failed = state === "failed";
  const path = useLaserState((laser) => laser.current);
  const toolLabelParams = useLaserState((laser) => path ? laser.open[path]?.state.toolLabelParams : undefined);
  const activityLevel = useActivityDetailLevel(path);
  // The agent's label is the row's durable primary title. The computed tool
  // summary stays visible beneath it, in every lifecycle state (D-282).
  const agentLabel = toolDisplayLabel({ name: toolName, args }, toolLabelParams);
  const bodySearchText = useCallback(() => toolSearchContent({
    name: toolName,
    args,
    result: props.result ?? (props.artifact as { partialOutput?: unknown } | undefined)?.partialOutput,
    isError: props.isError === true,
  }, toolLabelParams), [toolName, args, props.result, props.artifact, props.isError, toolLabelParams]);
  // Which MCP servers this session started with, so `playwright_browser_*` is
  // read as Playwright's own tool and not as a tool nobody recognises
  // (docs/mcp.md "In the transcript").
  const mcpServers = useSessionMcpServers(path);

  // The decision footer remains visible outside the fold. It never forces the
  // body open, and a manual row choice supersedes later status/mode changes.
  const [manualOpen, rememberOpen] = useActivityDisclosureOverride(path, `tool:${toolCallId}`);
  const open = manualOpen ?? toolDetailsDefaultOpen(activityLevel);

  const localElapsed = useElapsed(toolCallId, running || awaiting ? "running" : "done");
  const elapsed = timing ? (timing.completedAt ?? Date.now()) - timing.startedAt : localElapsed;

  const details = useMemo(() => resultDetails(result), [result]);
  const mcp = useMemo(
    () => (kind === "other" ? classifyMcpTool(toolName, details, mcpServers) : undefined),
    [kind, toolName, details, mcpServers],
  );
  const diffView = useMemo(
    () => (kind === "edit" || kind === "write" ? diffViewForTool(kind, args, details) : undefined),
    [kind, args, details],
  );
  const appliedDiffStats = status?.type === "complete" && state === "done" && diffView
    ? (diffView.stats ?? diffStats(diffView.hunks))
    : undefined;
  const diffDescription = appliedDiffStats ? diffStatDescription(appliedDiffStats) : undefined;
  // M16-T60: what of this call the window is not holding folds into the output
  // area it belongs to, with one action that reads the whole of it. A body
  // still being written says when it can be read instead.
  const bodies = (props.artifact as { bodies?: BlockBodies } | undefined)?.bodies;
  const outputBody = bodies?.result ?? (running ? bodies?.partial : undefined);
  const outputOverflows = omittedBytes(outputBody) > 0;
  // A page that left this output out holds none of it: read its first lines
  // while the row is open, so the fold never sits under an empty body.
  const preview = useOutputPreview(outputBody, path ?? undefined, open && outputOverflows && heldText.length === 0);
  const text = heldText || preview || "";
  const visibleArgs = withoutToolLabel(args, toolName, toolLabelParams);
  const argsHaveLabel = visibleArgs !== args;
  const visibleArgsText = argsHaveLabel ? JSON.stringify(visibleArgs) : argsText;
  const argsOverflow = omittedBytes(bodies?.args) > 0;
  const finishes = kind === "bash" ? "the command finishes" : "the tool finishes";
  const bash = kind === "bash" ? parseBashOutput(text, isError === true) : undefined;
  const context: OutputContext = {
    toolName,
    command: kind === "bash" && typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command : summary.summary,
    state,
    // An excerpt's head does not carry the exit trailer; only a known code is said.
    ...(bash && (!outputOverflows || /exited with code/i.test(text)) ? { exitCode: bash.exitCode } : {}),
    ...(elapsed !== undefined && !running ? { durationMs: elapsed } : {}),
  };
  const fold = (ground: FoldGround, fade: boolean) => outputOverflows
    ? <BodyOverflow body={outputBody} path={path ?? undefined} label="output" ground={ground} fade={fade} finishes={finishes} tool={context} />
    : undefined;
  const argsFold = argsOverflow
    ? <BodyOverflow body={bodies?.args} path={path ?? undefined} label="request" ground="surface-2" fade finishes={finishes} tool={{ toolName, state }} />
    : undefined;
  // Rows whose body is not a plain output area keep the fold directly under
  // the row, indented to its text, never as a box of its own.
  const footerFolds = (
    <>
      {outputOverflows ? <BodyOverflow body={outputBody} path={path ?? undefined} label="output" ground="surface" fade={false} finishes={finishes} tool={context} className="ms-4" /> : null}
      {argsOverflow ? <BodyOverflow body={bodies?.args} path={path ?? undefined} label="request" ground="surface" fade={false} finishes={finishes} tool={{ toolName, state }} className="ms-4" /> : null}
    </>
  );
  const footer = (
    <>
      {approval ? <RowApproval {...props} /> : null}
      {interrupt && isInterruptPayload(interrupt.payload) ? (
        <InterruptFooter payload={interrupt.payload} resume={props.resume} />
      ) : null}
      <ToolRowDialog toolCallId={toolCallId} />
    </>
  );
  const activeLabel = running ? agentLabel ?? activeToolLabel({ toolName, args }) : undefined;

  // An MCP call: the server's own tool, the gateway, or a script. Its row is
  // composed from the same parts, with the server's content as its body.
  if (mcp) {
    return (
      <ToolSearchBodyContext value={bodySearchText}>
        <McpToolRow
          info={mcp}
          toolName={toolName}
          args={visibleArgs}
          argsText={visibleArgsText}
          result={result}
          text={text}
          details={details}
          state={state}
          elapsedMs={elapsed}
          open={open}
          onOpenChange={rememberOpen}
          footer={<>{footerFolds}{footer}</>}
          label={agentLabel}
        />
      </ToolSearchBodyContext>
    );
  }

  // The harness's own tools (docs/agents.md): starting an agent gets a row
  // that names who was started and leads to its chat.
  if (toolName === START_AGENT_TOOL) {
    return (
      <StartAgentRow
        args={args}
        result={result}
        text={text}
        details={details}
        state={state}
        elapsed={elapsed}
        open={open}
        onOpenChange={rememberOpen}
        activeLabel={agentLabel}
        footer={<>{footerFolds}{footer}</>}
      />
    );
  }

  // A tool Pi does not ship normally draws as the catalog's fallback row.
  // Decisions route through our composed footer so authenticated capability
  // policy applies to both approvals and extension questions. The fallback
  // reads the agent's label itself when it owns the whole row.
  if (kind === "other") {
    if (!approval && !interrupt) {
      return (
        <>
          <ToolFallback {...props} />
          <ToolRowDialog toolCallId={toolCallId} />
        </>
      );
    }
    return (
      <ToolCall
        icon={TOOL_ICONS.other}
        verb={toolName}
        label={agentLabel}
        activeLabel={activeLabel}
        state={state}
        elapsedMs={elapsed}
        open={open}
        onOpenChange={rememberOpen}
        toolName={toolName}
        bodySearchText={bodySearchText}
        peek={failed && text ? <ToolError message={text} compact /> : undefined}
        footer={footer}
      >
        <TextBody args={visibleArgs} argsText={visibleArgsText} text={text} failed={failed} overflow={fold("surface-2", text.length > 0)} argsOverflow={argsFold} />
      </ToolCall>
    );
  }

  const body = toolBody(kind);
  const hasBody = body !== "text" || text.length > 0 || (args !== undefined && Object.keys(args as object).length > 0) || outputOverflows || argsOverflow;

  return (
    <ToolCall
      icon={TOOL_ICONS[kind]}
      verb={summary.verb}
      label={agentLabel}
      activeLabel={activeLabel}
      summary={summary.summary}
      detail={summary.detail}
      state={state}
      elapsedMs={elapsed}
      open={open}
      onOpenChange={rememberOpen}
      toolName={toolName}
      bodySearchText={bodySearchText}
      trailing={appliedDiffStats ? <DiffStat added={appliedDiffStats.added} removed={appliedDiffStats.removed} /> : undefined}
      accessibleDescription={diffDescription}
      peek={failed && text ? <ToolError message={text} compact /> : undefined}
      footer={footer}
    >
      {(kind === "write" || kind === "edit") && state === "done" && status?.type === "complete" && diffView?.path ? (
        <FileCard path={diffView.path} lines={kind === "write" ? appliedDiffStats?.added : undefined} />
      ) : null}
      {hasBody ? (
        body === "terminal" ? (
          <BashBody args={visibleArgs} text={text} running={running} isError={failed} overflow={fold("terminal", text.length > 0)} />
        ) : body === "diff" ? (
          <>
            <DiffBody view={diffView} args={visibleArgs} argsText={visibleArgsText} text={text} failed={failed} />
            {footerFolds}
          </>
        ) : kind === "read" ? (
          <ReadBody args={visibleArgs} argsText={visibleArgsText} text={text} failed={failed} overflow={fold("surface-2", text.length > 0)} argsOverflow={argsFold} />
        ) : (
          <TextBody args={visibleArgs} argsText={visibleArgsText} text={text} failed={failed} overflow={fold("surface-2", text.length > 0)} argsOverflow={argsFold} />
        )
      ) : undefined}
    </ToolCall>
  );
}

function ReadBody({ args, argsText, text, failed, overflow, argsOverflow }: { args: unknown; argsText?: string; text: string; failed: boolean; overflow?: ReactNode; argsOverflow?: ReactNode }) {
  const visibleArgs = args;
  const path = typeof (visibleArgs as { path?: unknown })?.path === "string" ? (visibleArgs as { path: string }).path : undefined;
  return (
    <>
      <ToolFallbackArgs argsText={argsText ?? pretty(visibleArgs)} overflow={argsOverflow} />
      {overflow && !failed ? <ToolFallbackResult result={text} overflow={overflow} /> : text ? (
        failed ? (
          <ToolFallbackSection label="error">
            <ToolError message={text} />
          </ToolFallbackSection>
        ) : (
          <ToolFallbackSection label="result">
            <div data-search-content>
              <Suspense fallback={<PlainSource code={text} />}>
                <ToolSourceCode path={path} code={text} />
              </Suspense>
            </div>
          </ToolFallbackSection>
        )
      ) : null}
      {overflow && failed ? overflow : null}
    </>
  );
}

function PlainSource({ code }: { code: string }) {
  return <pre dir="ltr" className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-2 px-3.5 py-3.5 font-mono text-xs leading-sm whitespace-pre text-ink">{code}</pre>;
}

export const ToolRow = memo(ToolRowImpl);

// ---------------------------------------------------------------------------
// start_agent — "Started explorer (default)" with the way to its chat
// ---------------------------------------------------------------------------

const START_AGENT_TOOL = "start_agent";

interface StartAgentResultInfo {
  sessionId?: string;
  runId?: string;
  /** Where the child is working: its worktree, or the checkout it shares with this session. */
  cwd?: string;
  /** Its worktree's branch; absent exactly when it has no worktree of its own. */
  branch?: string;
}

/**
 * What `start_agent` answered. A result that carries the harness's own
 * `details` (`cwd`) is read from there — live, and now also on reload, since a
 * stored result keeps its envelope when it has details (`storedToolResult`,
 * store.ts). A result written before that, or by a harness that attached
 * none, still reads the model's JSON view (`working_directory`). Both name
 * the run and where it works.
 */
function startAgentInfo(result: unknown, details: Record<string, unknown> | undefined, text: string): StartAgentResultInfo {
  const str = (source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof source?.[key] === "string" && source[key] !== "") return source[key] as string;
    return undefined;
  };
  const pick = (source: Record<string, unknown> | undefined): StartAgentResultInfo => {
    const cwd = str(source, "cwd", "working_directory");
    const branch = str(source, "branch");
    return {
      ...(typeof source?.["sessionId"] === "string" ? { sessionId: source["sessionId"] as string } : {}),
      ...(typeof source?.["runId"] === "string" ? { runId: source["runId"] as string } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(branch !== undefined ? { branch } : {}),
    };
  };
  const fromDetails = pick(details);
  if (fromDetails.runId || fromDetails.sessionId) return fromDetails;
  if (result === undefined || result === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? pick(parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The child's session path, once the registry or the catalog knows the run. */
function useStartedSessionPath(info: StartAgentResultInfo): string | undefined {
  return useLaserState((s) => {
    if (info.runId) {
      const run = s.agents.runs[info.runId];
      if (run) return run.sessionPath;
    }
    return s.sessions.find(
      (session) => (info.runId !== undefined && session.agent?.runId === info.runId) || (info.sessionId !== undefined && session.id === info.sessionId && session.agent?.kind === "child"),
    )?.path;
  });
}

function StartAgentRow({
  args,
  result,
  text,
  details,
  state,
  elapsed,
  open,
  onOpenChange,
  activeLabel,
  footer,
}: {
  args: unknown;
  result: unknown;
  text: string;
  details: Record<string, unknown> | undefined;
  state: ReturnType<typeof toolRowState>;
  elapsed: number | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
  activeLabel: string | undefined;
  footer: React.ReactNode;
}) {
  const { actions } = useLaserStable();
  const a = (args ?? {}) as { agent_name?: unknown; subagent_name?: unknown };
  const subagent = typeof a.subagent_name === "string" ? a.subagent_name : "";
  const agent = typeof a.agent_name === "string" ? a.agent_name : "";
  const running = state === "running";
  const failed = state === "failed";
  const info = useMemo(() => startAgentInfo(result, details, text), [result, details, text]);
  const childPath = useStartedSessionPath(info);
  const summary = subagent ? `${subagent}${agent ? ` (${agent})` : ""}` : agent;
  return (
    <ToolCall
      icon={Bot}
      verb={running ? "Starting" : failed ? "Could not start" : "Started"}
      activeLabel={activeLabel ?? `Starting ${summary || "an agent"}`}
      summary={summary}
      state={state}
      elapsedMs={elapsed}
      open={open}
      onOpenChange={onOpenChange}
      toolName={START_AGENT_TOOL}
      peek={failed && text ? <ToolError message={text} compact /> : undefined}
      footer={
        <>
          {info.cwd ? (
            // Where the child went, without opening it: its branch when it has
            // a worktree, otherwise the checkout it shares with this session.
            <Hint data-slot="start-agent-where" className="mb-1 ms-6 flex min-w-0 items-center gap-1.5 text-xs leading-sm text-ink-3" hint={info.cwd}>
              {info.branch ? <GitBranch aria-hidden="true" className="size-3.5 shrink-0" /> : <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />}
              <span className="typed truncate">{info.branch ?? info.cwd}</span>
              {info.branch ? null : <span className="shrink-0">· this session’s checkout</span>}
            </Hint>
          ) : null}
          {childPath ? (
            <div data-slot="start-agent-open" className="mb-1 ms-6 flex items-center">
              <Button size="xs" variant="ghost" className="-ms-1.5 text-ink-2" onClick={() => void actions.openSession(childPath)}>
                <MessageSquare />
                Open chat
              </Button>
            </div>
          ) : null}
          {footer}
        </>
      }
    >
      <TextBody args={args} text={text} failed={failed} />
    </ToolCall>
  );
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function BashBody({ args, text, running, isError, overflow }: { args: unknown; text: string; running: boolean; isError: boolean; overflow?: ReactNode }) {
  const visibleArgs = args;
  const command = typeof (visibleArgs as { command?: unknown })?.command === "string" ? (visibleArgs as { command: string }).command : "";
  const { output, exitCode } = useMemo(() => parseBashOutput(text, isError), [text, isError]);
  return <TerminalBlock command={command} output={output} exitCode={exitCode} running={running} isError={isError} overflow={overflow} />;
}

function DiffBody({
  view,
  args,
  argsText,
  text,
  failed,
}: {
  view: ReturnType<typeof diffViewForTool>;
  args: unknown;
  argsText?: string;
  text: string;
  failed: boolean;
}) {
  const visibleArgs = args;
  return (
    <>
      {view ? <CodeDiff view={view} /> : <ToolFallbackArgs argsText={argsText ?? pretty(visibleArgs)} />}
      {failed && text ? (
        <ToolFallbackSection label="error">
          <ToolError message={text} />
        </ToolFallbackSection>
      ) : null}
    </>
  );
}

function TextBody({ args, argsText, text, failed, overflow, argsOverflow }: { args: unknown; argsText?: string; text: string; failed: boolean; overflow?: ReactNode; argsOverflow?: ReactNode }) {
  const visibleArgs = args;
  return (
    <>
      <ToolFallbackArgs argsText={argsText ?? pretty(visibleArgs)} overflow={argsOverflow} />
      {failed && text ? (
        <ToolFallbackSection label="error">
          <ToolError message={text} />
        </ToolFallbackSection>
      ) : null}
      {failed ? overflow ?? null : text || overflow ? <ToolFallbackResult result={text} overflow={overflow} /> : null}
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
  const capability = useCapability("pi/ui/response", { presentation: "explained" });
  const running = useAuiState((s) => s.thread.isRunning);
  const denyFeedback = useCallback(
    async (reason: string) => {
      await actions.send([{ type: "text", text: `Denied: ${reason}` }], running ? "steer" : "prompt").catch(() => {});
    },
    [actions, running],
  );
  if (capability.state !== "available") return capability.state === "explained" ? (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink">{props.approval?.prompt ?? "Allow this?"}</p>
      <CapabilityNotice title="This decision must be made elsewhere" explanation={capability.explanation} />
    </div>
  ) : null;
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
 * A question raised while exactly one tool runs, rendered inside that tool's
 * row. It is the same `DialogBody` as the card above the composer — one
 * renderer, so a question never looks like two different things depending on
 * where it happened to be asked.
 *
 * It answers through assistant-ui's `resume` rather than `pi/ui/response`,
 * because this payload reached the row through the tool call itself. The
 * other road — a question that arrives on the `pi/ui/request` stream — is
 * `ToolRowDialog`, mounted in the same footer.
 */
function InterruptFooter({ payload, resume }: { payload: InterruptPayload; resume: (payload: unknown) => void }) {
  const form = useMemo(
    () =>
      dialogFormOf(
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
  const capability = useCapability("pi/ui/response", { presentation: "explained" });
  if (capability.state !== "available") return capability.state === "explained" ? (
    <div data-slot="interrupt-footer" className="mb-2 ms-6 flex flex-col gap-2 border-s-2 border-attention py-1 ps-3">
      <p className="text-sm font-medium text-ink">{payload.title}</p>
      {payload.message ? <p className="text-sm text-ink-2">{payload.message}</p> : null}
      <CapabilityNotice title="This question must be answered elsewhere" explanation={capability.explanation} />
    </div>
  ) : null;
  return (
    <div data-slot="interrupt-footer" className="mb-2 ms-6 border-s-2 border-attention py-1 ps-3">
      <DialogBody
        form={form}
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
