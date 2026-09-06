"use client";
import { useSearchReveal } from "@/components/thread/search-state";
/**
 * `tool-fallback` (assistant-ui registry), restyled to DESIGN.md.
 *
 * The parts — Root, Trigger, Content, Args, Result, Error, Approval — are the
 * building blocks of every tool row in the transcript; `ToolFallback`, the
 * default export, is the row an *unknown* tool gets (docs/ux-elements.md
 * "Tool fallback"). Pi's built-ins draw through `tool-call.tsx`, which
 * composes the same parts with a verb, a typed summary and a body.
 *
 * Divergences from the registry copy, each on purpose:
 *   - Row grammar is `[icon] verb summary ····· duration ›` (DESIGN.md
 *     "Transcript"), so the trigger takes `verb`/`summary`/`detail`/`icon`.
 *   - Colours, sizes and durations come from tokens; the copy's 200ms
 *     constant is read from `--motion-fast` at call time.
 *   - Deny is never a dead end: with `denyFeedback`, "Deny" opens a field
 *     whose text is sent to the agent as `Denied: …` (D-20).
 *   - The error part draws the danger hairline the row promises.
 */
import {
  toolApprovalAcceptsText,
  useScrollLock,
  useToolCallElapsed,
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { ChevronRight, CircleAlert, Wrench } from "lucide-react";
import { memo, useCallback, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";

import { StatusDot } from "@/components/status";
import { ActivityBeam, ThinkingIndicator } from "./thinking-indicator.js";
import { activeToolLabel } from "@/components/thread/tool-groups";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { duration as formatDuration } from "@/format";
import { cn } from "@/lib/utils";
import { toolDetailsDefaultOpen, toolDisplayResult, useActivityDetailLevel, useLaserState, type ActivityDetailLevel } from "@/runtime";
import { JsonViewer, parseJsonText } from "./json-viewer.js";

import { activityRow, activityTrigger, collapsePanel, mono, pressable } from "./surfaces.js";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** `--motion-fast` in ms, read when needed so a theme change is honoured. */
function motionFastMs(): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-fast").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type ToolFallbackRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  /** Danger (an error) or attention (a decision) hairline on the start edge. */
  tone?: "danger" | "attention" | undefined;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  tone,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [lockMs] = useState(motionFastMs);
  const lockScroll = useScrollLock(collapsibleRef, lockMs);

  const isControlled = controlledOpen !== undefined;
  const reveal = useSearchReveal();
  const isOpen = reveal || (isControlled ? controlledOpen : uncontrolledOpen);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      lockScroll();
      if (!isControlled) setUncontrolledOpen(next);
      controlledOnOpenChange?.(next);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      data-tone={tone}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        activityRow, "group/tool",
        tone === "danger" && "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-danger",
        tone === "attention" &&
          "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-attention",
        className,
      )}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

function ToolFallbackDuration({
  className,
  running = false,
  elapsedMs,
  ...props
}: React.ComponentProps<"span"> & { running?: boolean | undefined; elapsedMs?: number | undefined }) {
  const runtimeElapsed = useToolCallElapsed();
  const ms = elapsedMs ?? runtimeElapsed;
  if (ms === undefined) return null;
  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(mono, "shrink-0 tnum", running ? "text-live" : "text-ink-3", className)}
      {...props}
    >
      {formatDuration(ms)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Trigger — `[icon] verb summary ····· duration ›`
// ---------------------------------------------------------------------------

export type ToolRowState = "running" | "awaiting" | "done" | "failed" | "cancelled";

export function toolRowState(status: ToolCallMessagePartStatus | undefined, isError: boolean | undefined): ToolRowState {
  if (!status) return "done";
  if (status.type === "running") return "running";
  if (status.type === "requires-action") return "awaiting";
  if (status.type === "incomplete" && status.reason === "cancelled") return "cancelled";
  if (isError === true || status.type === "incomplete") return "failed";
  return "done";
}

export type ToolFallbackTriggerProps = Omit<React.ComponentProps<typeof CollapsibleTrigger>, "children"> & {
  /** Host Grotesk 500 verb: "Read", "Run", or the tool's name for an unknown tool. */
  verb: string;
  activeLabel?: string | undefined;
  /** Typed fragment: a path, a command, a pattern. */
  summary?: string | undefined;
  /** Second typed fragment in tertiary ink, e.g. `L12–40`. */
  detail?: string | undefined;
  icon?: Icon | undefined;
  state?: ToolRowState | undefined;
  /** Wall-clock elapsed when the caller keeps its own clock; otherwise `useToolCallElapsed`. */
  elapsedMs?: number | undefined;
  /** No chevron and no hover when there is nothing to expand. */
  expandable?: boolean | undefined;
  /** Trailing fragment before the duration, e.g. "2 failed". */
  trailing?: ReactNode;
};

function ToolFallbackTrigger({
  verb,
  activeLabel,
  summary,
  detail,
  icon,
  state = "done",
  elapsedMs,
  expandable = true,
  trailing,
  className,
  ...props
}: ToolFallbackTriggerProps) {
  const running = state === "running";
  const failed = state === "failed";
  const awaiting = state === "awaiting";
  const cancelled = state === "cancelled";
  const LeadIcon = icon ?? Wrench;

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      data-active={running || undefined}
      disabled={!expandable}
      aria-label={running && activeLabel ? activeLabel : `${verb} ${summary ?? ""}`.trim()}
      className={cn(
        activityTrigger,
        "disabled:cursor-default disabled:hover:bg-transparent disabled:active:bg-transparent",
        className,
      )}
      {...props}
    >
      {running && <ActivityBeam />}
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {running ? (
          <StatusDot status="working" size="sm" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-3.5 text-danger" />
        ) : (
          <LeadIcon className={cn("size-3.5", awaiting ? "text-attention" : "text-ink-3")} />
        )}
      </span>
      {running && activeLabel ? <ThinkingIndicator label={activeLabel} dot={false}
        className="min-w-0 flex-1 overflow-hidden [&_[data-slot=thinking-indicator-label]]:truncate" /> : <span
        data-slot="tool-fallback-trigger-label"
        className={cn("min-w-0 truncate text-sm font-medium", cancelled ? "text-ink-3 line-through" : "text-ink-2", running && "shimmer-text")}
      >
        {verb}
      </span>}
      {summary && !(running && activeLabel) ? (
        <span className={cn(mono, "min-w-0 truncate", cancelled ? "text-ink-3" : "text-ink-2")} title={summary}>
          {summary}
        </span>
      ) : null}
      {detail ? <span className={cn(mono, "shrink-0 text-ink-3")}>{detail}</span> : null}
      <span
        aria-hidden="true"
        className="flex-1"
      />
      {trailing}
      {cancelled ? (
        <span className={cn(mono, "shrink-0 text-ink-3")}>cancelled</span>
      ) : (
        <ToolFallbackDuration running={running} elapsedMs={elapsedMs} />
      )}
      {expandable ? (
        <ChevronRight
          data-slot="tool-fallback-trigger-chevron"
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none",
            "group-data-[state=open]/trigger:rotate-90",
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden="true" />
      )}
    </CollapsibleTrigger>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function ToolFallbackContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent data-slot="tool-fallback-content" className={cn(collapsePanel, "outline-none", className)} {...props}>
      <div className="flex min-w-0 flex-col gap-2 border-t border-line px-2 py-2">{children}</div>
    </CollapsibleContent>
  );
}

/** An eyebrow over a block of the body. */
function ToolFallbackSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Args / Result / Error
// ---------------------------------------------------------------------------

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & { argsText?: string | undefined }) {
  if (!argsText) return null;
  const json = parseJsonText(argsText);
  return (
    <div data-slot="tool-fallback-args" className={cn(className)} {...props}>
      <ToolFallbackSection label="args">
        {json === undefined ? <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-ink-2">{argsText}</pre> : <JsonViewer value={json} expandedDepth={1} className="max-h-80" />}
      </ToolFallbackSection>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & { result?: unknown }) {
  if (result === undefined) return null;
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (!text) return null;
  return (
    <div data-slot="tool-fallback-result" className={cn(className)} {...props}>
      <ToolFallbackSection label="result">
        {typeof result === "string" && parseJsonText(result) === undefined ? <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-ink-2">{text}</pre> : <JsonViewer value={typeof result === "string" ? parseJsonText(result) : result} expandedDepth={1} className="max-h-80" />}
      </ToolFallbackSection>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & { status?: ToolCallMessagePartStatus | undefined }) {
  if (status?.type !== "incomplete") return null;
  const error = status.error;
  const errorText = error ? (typeof error === "string" ? error : JSON.stringify(error)) : null;
  if (!errorText) return null;
  const cancelled = status.reason === "cancelled";
  return (
    <div data-slot="tool-fallback-error" className={cn(className)} {...props}>
      <ToolFallbackSection label={cancelled ? "cancelled" : "error"}>
        <p className={cn(mono, "wrap-break-word whitespace-pre-wrap", cancelled ? "text-ink-2" : "text-danger")}>{errorText}</p>
      </ToolFallbackSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approval — "No" is never a dead end
// ---------------------------------------------------------------------------

const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  "allow-once": "Allow",
  "allow-always": "Always allow",
  "reject-once": "Deny",
  "reject-always": "Always deny",
};

const isKnownKind = (kind: string) => Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, kind);
const isAllowKind = (kind: string) => kind === "allow-once" || kind === "allow-always";
const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ?? (isKnownKind(option.kind) ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind] : undefined) ?? option.id;

/** A request that declares how it wants to be presented is a question, not a gate: a refusal is not one of its answers. */
const isQuestion = (approval: ToolCallMessagePart["approval"]) => approval?.display === "select" || approval?.display === "text";

const offersInterruptAction = (
  status: ToolCallMessagePartStatus | undefined,
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"],
) => status?.type !== "requires-action" || status.reason !== "interrupt" || approval != null || interrupt != null;

export type ToolFallbackApprovalProps = React.ComponentProps<"div"> &
  Partial<Pick<ToolCallMessagePartProps, "addResult" | "resume" | "respondToApproval" | "status">> & {
    interrupt?: ToolCallMessagePart["interrupt"];
    approval?: ToolCallMessagePart["approval"];
    /**
     * Where a denial's reason goes. When given, "Deny" opens a field and the
     * text is delivered to the agent (as `Denied: …`) before the denial lands,
     * so the model reads why right after the refused tool result.
     */
    denyFeedback?: ((reason: string) => Promise<void> | void) | undefined;
  };

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  status,
  denyFeedback,
  ...props
}: ToolFallbackApprovalProps) {
  const [submitted, setSubmitted] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (approval != null && (approval.approved !== undefined || approval.resolution !== undefined)) {
    const label =
      approval.resolution === "expired"
        ? "Timed out"
        : approval.resolution === "cancelled"
          ? "Cancelled"
          : approval.approved
            ? "Allowed"
            : "Denied";
    return (
      <p data-slot="tool-fallback-approval-outcome" className={cn(mono, "mb-1.5 ms-6 text-ink-3", className)}>
        {label}
      </p>
    );
  }

  if (!offersInterruptAction(status, approval, interrupt)) return null;

  const declaredOptions = respondToApproval ? approval?.options : undefined;
  const acceptsText = approval != null && respondToApproval != null && toolApprovalAcceptsText(approval);
  const question = isQuestion(approval);

  const submit = (send: () => Promise<void> | void) => {
    setSubmitted(true);
    setError(null);
    void (async () => {
      try {
        await send();
      } catch (sendError) {
        setSubmitted(false);
        setError(sendError instanceof Error ? sendError.message : String(sendError));
      }
    })();
  };

  const typedAnswer = () => (answer.trim() ? { text: answer.trim() } : {});

  const respond = (approved: boolean) => {
    if (submitted) return;
    const reason = answer.trim();
    submit(async () => {
      if (!approved && reason && denyFeedback) await denyFeedback(reason);
      if (approval != null && approval.approved === undefined && respondToApproval) {
        await respondToApproval({ approved, ...(reason ? { reason } : {}), ...typedAnswer() });
      } else if (interrupt) {
        await resume?.({ approved });
      } else if (status?.type === "requires-action" && status.reason === "interrupt") {
        return;
      } else {
        await addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
      }
    });
  };

  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    setConfirmingId(null);
    submit(() =>
      respondToApproval?.(
        isKnownKind(option.kind)
          ? { optionId: option.id, ...typedAnswer() }
          : { optionId: option.id, approved: true, ...typedAnswer() },
      ),
    );
  };

  const submitAnswer = () => {
    if (submitted || !answer.trim()) return;
    submit(() => respondToApproval?.({ text: answer.trim() }));
  };

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) setConfirmingId(option.id);
    else respondWithOption(option);
  };

  const confirming = confirmingId != null ? declaredOptions?.find((o) => o.id === confirmingId) : undefined;

  const frame = cn("mb-2 ms-6 flex flex-col gap-2 border-s-2 border-attention py-1 ps-3", className);
  const promptText = <p className="text-sm text-ink">{approval?.prompt ?? "Allow this?"}</p>;
  const errorText = error ? (
    <p role="alert" className="text-xs text-danger">
      {error}
    </p>
  ) : null;

  const field = (label: string, placeholder: string, onEnter: () => void) => (
    <Textarea
      autoFocus
      value={answer}
      onChange={(event) => setAnswer(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onEnter();
        }
      }}
      disabled={submitted}
      aria-label={label}
      placeholder={placeholder}
      className="max-h-40 min-h-16"
    />
  );

  if (confirming) {
    const confirmMeta = typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription = confirmMeta?.description ?? confirming.description;
    return (
      <div data-slot="tool-fallback-approval-confirm" className={frame} {...props}>
        <p className="text-sm font-medium text-ink">{confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}</p>
        {confirmDescription ? <p className="text-sm text-ink-2">{confirmDescription}</p> : null}
        {confirming.grants && confirming.grants.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-2">{grant}</code>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <Button size="sm" className={pressable} onClick={() => respondWithOption(confirming)} disabled={submitted}>
            Confirm
          </Button>
          <Button size="sm" variant="ghost" className={pressable} onClick={() => setConfirmingId(null)} disabled={submitted}>
            Back
          </Button>
        </div>
        {errorText}
      </div>
    );
  }

  // Deny with a reason: the field first, then the buttons that use it.
  if (denying) {
    return (
      <div
        data-slot="tool-fallback-approval"
        className={frame}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDenying(false);
          }
        }}
        {...props}
      >
        {promptText}
        {field("Why not? Sent to the agent", "Tell the agent why (sent as “Denied: …”)", () => respond(false))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" className={pressable} disabled={submitted} onClick={() => respond(false)}>
            {answer.trim() ? "Send and deny" : "Deny"}
          </Button>
          <Button size="sm" variant="ghost" className={pressable} disabled={submitted} onClick={() => setDenying(false)}>
            Back
          </Button>
        </div>
        {errorText}
      </div>
    );
  }

  // Autofocused wherever it is the only way out: on a question that gates
  // tool execution, Enter must never be the keystroke that allows.
  const denyButton = (
    <Button
      size="sm"
      variant="outline"
      autoFocus
      className={pressable}
      onClick={() => (denyFeedback ? setDenying(true) : respond(false))}
      disabled={submitted}
    >
      Deny
    </Button>
  );

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = declaredOptions.filter((o) => isAllowKind(o.kind));
    const customOptions = declaredOptions.filter((o) => !isKnownKind(o.kind));
    const rejectOptions = declaredOptions.filter((o) => isKnownKind(o.kind) && !isAllowKind(o.kind));
    return (
      <div data-slot="tool-fallback-approval" className={frame} {...props}>
        {promptText}
        <div className="flex flex-wrap items-center gap-2">
          {[...allowOptions, ...customOptions, ...rejectOptions].map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option === allowOptions[0] ? "default" : "outline"}
              className={pressable}
              onClick={() => handleOption(option)}
              disabled={submitted}
              autoFocus={option === rejectOptions[0]}
            >
              {approvalOptionLabel(option)}
            </Button>
          ))}
          {rejectOptions.length === 0 && !question ? denyButton : null}
        </div>
        {acceptsText ? field(question ? (approval?.prompt ?? "Answer") : "Note", question ? "Type your answer" : "Add a note to your decision", submitAnswer) : null}
        {acceptsText && question ? (
          <Button size="sm" className={cn(pressable, "self-start")} onClick={submitAnswer} disabled={submitted || !answer.trim()}>
            Send
          </Button>
        ) : null}
        {errorText}
      </div>
    );
  }

  if (question) {
    return (
      <div data-slot="tool-fallback-approval" className={frame} {...props}>
        {promptText}
        {acceptsText ? field(approval?.prompt ?? "Answer", "Type your answer", submitAnswer) : null}
        {acceptsText ? (
          <Button size="sm" className={cn(pressable, "self-start")} onClick={submitAnswer} disabled={submitted || !answer.trim()}>
            Send
          </Button>
        ) : null}
        {errorText}
      </div>
    );
  }

  return (
    <div data-slot="tool-fallback-approval" className={frame} {...props}>
      {promptText}
      <div className="flex items-center gap-2">
        <Button size="sm" className={pressable} onClick={() => respond(true)} disabled={submitted}>
          Allow
        </Button>
        {denyButton}
      </div>
      {errorText}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The unknown tool's row
// ---------------------------------------------------------------------------

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result: finalResult,
  artifact,
  status,
  isError,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const result = toolDisplayResult({ result: finalResult, artifact });
  const state = toolRowState(status, isError);
  const isRequiresAction = status?.type === "requires-action";
  const shouldRenderApproval = isRequiresAction && offersInterruptAction(status, approval, interrupt);
  const path = useLaserState((laser) => laser.current);
  const activityLevel = useActivityDetailLevel(path);
  const [userOpen, setUserOpen] = useState<{ level: ActivityDetailLevel; open: boolean } | null>(null);
  const open = userOpen?.level === activityLevel ? userOpen.open : isRequiresAction || toolDetailsDefaultOpen(activityLevel);

  const hasBody = Boolean(argsText) || result !== undefined || status?.type === "incomplete";
  const tone = state === "failed" ? "danger" : state === "awaiting" ? "attention" : undefined;

  return (
    <ToolFallbackRoot
      open={open}
      onOpenChange={(next) => setUserOpen({ level: activityLevel, open: next })}
      tone={tone}
      data-tool={toolName}
      data-status={status?.type}
    >
      <ToolFallbackTrigger verb={toolName} activeLabel={activeToolLabel({ toolName, args })} state={state} expandable={hasBody} />
      {hasBody ? (
        <ToolFallbackContent>
          <ToolFallbackError status={status} />
          <ToolFallbackArgs argsText={argsText} className={cn(state === "cancelled" && "opacity-60")} />
          {state !== "cancelled" ? <ToolFallbackResult result={result} /> : null}
        </ToolFallbackContent>
      ) : null}
      {shouldRenderApproval ? (
        <ToolFallbackApproval
          addResult={addResult}
          resume={resume}
          interrupt={interrupt}
          approval={approval}
          respondToApproval={respondToApproval}
          status={status}
        />
      ) : null}
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Section: typeof ToolFallbackSection;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Section = ToolFallbackSection;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackSection,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
  ToolFallbackDuration,
};
