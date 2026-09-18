"use client";
import { useFindQuery, useSearchReveal } from "@/components/thread/search-state";
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
import { memo, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";

import { StatusDot } from "@/components/status";
import { ActivityBeam, ThinkingIndicator } from "./thinking-indicator.js";
import { activeToolLabel } from "@/components/thread/tool-groups";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { duration as formatDuration } from "@/format";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";
import { toolDetailsDefaultOpen, toolDisplayResult, useActivityDetailLevel, useLaserState } from "@/runtime";
import { useActivityDisclosureOverride } from "@/runtime/sessionPreferences";
import { BodyOverflow } from "@/components/thread/BodyOverflow";
import { JsonViewer, parseJsonText } from "./json-viewer.js";
import type { BlockBodies } from "@/store";
import { omittedBytes } from "@/runtime/body-excerpt";
import { toolDisplayLabel, toolOutputText, toolSearchContent, withoutToolLabel } from "@lasercode/protocol";

import { activityDisclosure, activityRow, activityTrigger, collapsePanel, mono, pressable } from "./surfaces.js";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type ToolFallbackRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  /** Danger (an error) or attention (a decision) hairline on the start edge. */
  tone?: "danger" | "attention" | undefined;
  /** Visible trigger text that find can highlight without opening the body. */
  visibleSearchText?: string | undefined;
  /** Lazily reads the body's shared search projection, excluding the visible trigger label. */
  bodySearchText?: (() => readonly string[]) | undefined;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  tone,
  visibleSearchText,
  bodySearchText,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  // The token at render, never frozen at mount (`@/motion`).
  const lockScroll = useScrollLock(collapsibleRef, motionMs("--motion-fast"));

  const isControlled = controlledOpen !== undefined;
  const baseOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const query = useFindQuery().trim();
  const revealing = useSearchReveal();
  const queryMatches = useCallback(
    (text: string) => query !== "" && text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    [query],
  );
  const visibleMatch = visibleSearchText !== undefined && queryMatches(visibleSearchText);
  const bodyMatch = revealing && query !== "" ? bodySearchText?.().some(queryMatches) ?? false : false;
  // Only a header-only match stays folded. If the shared body projection also
  // matches, the body must mount so every indexed occurrence has a DOM range.
  const headerOnlyMatch = revealing && visibleMatch && bodySearchText !== undefined && !bodyMatch;
  const [transientOverride, setTransientOverride] = useState<{ query: string; open: boolean } | null>(null);
  useEffect(() => { if (!revealing) setTransientOverride(null); }, [revealing]);
  // Keying the override by query prevents a manual toggle for the previous
  // query leaking through the render before effects run.
  const revealedOpen = transientOverride?.query === query ? transientOverride.open : undefined;
  const isOpen = revealing ? (revealedOpen ?? (headerOnlyMatch ? baseOpen : true)) : baseOpen;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      lockScroll();
      // A choice while find is revealing this row belongs to that query alone;
      // it never writes the person's remembered disclosure preference.
      if (revealing) {
        setTransientOverride({ query, open: next });
        return;
      }
      if (!isControlled) setUncontrolledOpen(next);
      controlledOnOpenChange?.(next);
    },
    [lockScroll, revealing, query, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      data-search-tool
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

/**
 * `nonzero` is a shell command that ran and came back non-zero: a settled
 * result, not a failure of the app. It draws as an ordinary finished row —
 * no rail, no alert icon, no error excerpt — with the command itself in the
 * quiet danger ink. `failed` stays what it is: a tool that broke.
 */
export type ToolRowState = "running" | "awaiting" | "done" | "failed" | "nonzero" | "cancelled";

export function toolRowState(
  status: ToolCallMessagePartStatus | undefined,
  isError: boolean | undefined,
  /** `isNonZeroExit(...)` for this call; see `thread/tool-summary.ts`. */
  nonZeroExit = false,
): ToolRowState {
  if (!status) return "done";
  if (status.type === "running") return "running";
  if (status.type === "requires-action") return "awaiting";
  if (status.type === "incomplete" && status.reason === "cancelled") return "cancelled";
  if (nonZeroExit) return "nonzero";
  if (isError === true || status.type === "incomplete") return "failed";
  return "done";
}

export type ToolFallbackTriggerProps = Omit<React.ComponentProps<typeof CollapsibleTrigger>, "children"> & {
  /** Lifecycle disclosures do not own a second usage/timing display. */
  showDuration?: boolean;
  /** Host Grotesk 500 verb: "Read", "Run", or the tool's name for an unknown tool. */
  verb: string;
  /** Agent-written durable title, separate from the tool's computed summary. */
  label?: string | undefined;
  /** Computed live fallback when no agent-written label exists. */
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

interface TriggerCopyProps {
  verb: string;
  summary: string | undefined;
  detail: string | undefined;
  running: boolean;
  cancelled: boolean;
  nonZero: boolean;
}

function TriggerCopyLabelled({ label, verb, summary, detail, running, cancelled, nonZero }: TriggerCopyProps & { label: string }) {
  return (
    <span data-slot="tool-fallback-trigger-copy" className="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden py-1">
      {running ? (
        <span data-search-content className="max-w-full min-w-0">
          <ThinkingIndicator
            label={label}
            dot={false}
            className="min-w-0 max-w-full overflow-hidden [&_[data-slot=thinking-indicator-label]]:truncate"
          />
        </span>
      ) : (
        <span
          data-search-content
          data-slot="tool-fallback-trigger-label"
          className={cn("max-w-full min-w-0 break-words text-start text-sm font-medium", cancelled ? "text-ink-3 line-through" : "text-ink-2")}
        >
          {label}
        </span>
      )}
      <span data-slot="tool-fallback-trigger-secondary" className={cn("flex max-w-full min-w-0 items-center gap-1.5 text-xs", cancelled ? "text-ink-3 line-through" : "text-ink-3")}>
        <span className="shrink-0 font-medium">{verb}</span>
        {summary ? (
          <span className={cn(mono, "min-w-0 truncate", nonZero && "text-danger-quiet")} title={summary}>
            {summary}
          </span>
        ) : null}
        {detail ? <span className={cn(mono, "shrink-0")}>{detail}</span> : null}
      </span>
    </span>
  );
}

function TriggerCopyPlain({ verb, activeLabel, summary, detail, running, cancelled, nonZero }: TriggerCopyProps & { activeLabel: string | undefined }) {
  return (
    <>
      {running && activeLabel ? <ThinkingIndicator label={activeLabel} dot={false}
        className="min-w-0 flex-initial overflow-hidden [&_[data-slot=thinking-indicator-label]]:truncate" /> : <span
        data-slot="tool-fallback-trigger-label"
        className={cn("min-w-0 truncate text-sm font-medium", cancelled ? "text-ink-3 line-through" : "text-ink-2", running && "shimmer-text")}
      >
        {verb}
      </span>}
      {summary && !(running && activeLabel) ? (
        <span
          data-slot="tool-fallback-trigger-summary"
          className={cn(mono, "min-w-0 truncate", cancelled ? "text-ink-3" : nonZero ? "text-danger-quiet" : "text-ink-2")}
          title={summary}
        >
          {summary}
        </span>
      ) : null}
      {detail ? <span className={cn(mono, "shrink-0 text-ink-3")}>{detail}</span> : null}
      <span aria-hidden="true" className="flex-1" />
    </>
  );
}

function ToolFallbackTrigger({
  verb,
  label,
  activeLabel,
  summary,
  detail,
  icon,
  state = "done",
  elapsedMs,
  expandable = true,
  showDuration = true,
  trailing,
  className,
  ...props
}: ToolFallbackTriggerProps) {
  const running = state === "running";
  const failed = state === "failed";
  const awaiting = state === "awaiting";
  const cancelled = state === "cancelled";
  const nonZero = state === "nonzero";
  const LeadIcon = icon ?? Wrench;
  const computedTitle = `${verb} ${summary ?? ""}`.trim();
  const labelledOffset = "mt-1.5";

  const accessibleLabel = label
    ? `${label}. ${computedTitle}${nonZero ? ", exited non-zero" : ""}`
    : running && activeLabel
      ? activeLabel
      : `${computedTitle}${nonZero ? ", exited non-zero" : ""}`;

  return (
    <div
      data-slot="tool-fallback-trigger-row"
      data-active={running || undefined}
      className={cn(activityTrigger, label && "items-start", className)}
    >
      {running && <ActivityBeam />}
      <span className={cn("flex size-4 shrink-0 items-center justify-center", label && labelledOffset)} aria-hidden="true">
        {running ? (
          <StatusDot status="working" size="sm" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-3.5 text-danger" />
        ) : (
          <LeadIcon className={cn("size-3.5", awaiting ? "text-attention" : "text-ink-3")} />
        )}
      </span>
      {label ? (
        <TriggerCopyLabelled label={label} verb={verb} summary={summary} detail={detail} running={running} cancelled={cancelled} nonZero={nonZero} />
      ) : (
        <TriggerCopyPlain verb={verb} activeLabel={activeLabel} summary={summary} detail={detail} running={running} cancelled={cancelled} nonZero={nonZero} />
      )}
      {label && trailing ? <span className={cn("shrink-0", labelledOffset)}>{trailing}</span> : trailing}
      {cancelled ? (
        <span className={cn(mono, "shrink-0 text-ink-3", label && labelledOffset)}>cancelled</span>
      ) : (
        showDuration ? <ToolFallbackDuration className={label ? labelledOffset : undefined} running={running} elapsedMs={elapsedMs} /> : null
      )}
      {expandable ? (
        <CollapsibleTrigger
          data-slot="tool-fallback-trigger"
          data-active={running || undefined}
          // Quiet, not hidden: the row says nothing about the exit visually beyond
          // the colour of the command, so the accessible name says it in words.
          aria-label={accessibleLabel}
          className={cn(activityDisclosure, label && labelledOffset)}
          {...props}
        >
          <ChevronRight
            data-slot="tool-fallback-trigger-chevron"
            aria-hidden="true"
            className={cn("rtl:-scale-x-100",
              "size-3.5 shrink-0 transition-transform duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none",
              "group-data-[state=open]/disclosure:rotate-90 group-data-[state=open]/disclosure:rtl:-rotate-90",
            )}
          />
        </CollapsibleTrigger>
      ) : (
        <span className={cn("size-8 pointer-coarse:size-11 shrink-0", label && labelledOffset)} aria-hidden="true" />
      )}
    </div>
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

/**
 * A body the transcript holds only part of (M16-T60): the excerpt and its fold
 * share one inset ground, so the fold is the end of the output area rather
 * than a box beside it.
 */
function FoldedText({ text, overflow }: { text: string; overflow: ReactNode }) {
  return (
    <div data-slot="tool-fallback-folded" className="overflow-hidden rounded-lg border border-line bg-surface-2">
      {text ? <pre dir="ltr" data-search-content className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-ink-2">{text}</pre> : null}
      {overflow}
    </div>
  );
}

function ToolFallbackArgs({
  argsText,
  overflow,
  className,
  ...props
}: React.ComponentProps<"div"> & { argsText?: string | undefined; overflow?: ReactNode }) {
  if (!argsText && !overflow) return null;
  const json = overflow || !argsText ? undefined : parseJsonText(argsText);
  return (
    <div data-slot="tool-fallback-args" className={cn(className)} {...props}>
      <ToolFallbackSection label="args">
        {overflow ? <FoldedText text={argsText ?? ""} overflow={overflow} /> : json === undefined ? <pre dir="ltr" className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-ink-2">{argsText}</pre> : <JsonViewer value={json} expandedDepth={1} className="max-h-80" />}
      </ToolFallbackSection>
    </div>
  );
}

function ToolFallbackResult({
  result: rawResult,
  overflow,
  className,
  ...props
}: React.ComponentProps<"div"> & { result?: unknown; overflow?: ReactNode }) {
  // Transport envelopes are not conversation content. Hydrated and live calls
  // show the same output; opaque non-envelope JSON retains its fallback viewer.
  const result = toolOutputText(rawResult) ?? rawResult;
  if (overflow) {
    const excerpt = result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return (
      <div data-slot="tool-fallback-result" className={cn(className)} {...props}>
        <ToolFallbackSection label="result">
          <FoldedText text={excerpt} overflow={overflow} />
        </ToolFallbackSection>
      </div>
    );
  }
  if (result === undefined) return null;
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (!text) return null;
  return (
    <div data-slot="tool-fallback-result" className={cn(className)} {...props}>
      <ToolFallbackSection label="result">
        {typeof result === "string" && parseJsonText(result) === undefined ? <pre dir="ltr" data-search-content className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-sm wrap-break-word whitespace-pre-wrap text-ink-2">{text}</pre> : <JsonViewer value={typeof result === "string" ? parseJsonText(result) : result} expandedDepth={1} className="max-h-80" />}
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
                <code dir="ltr" className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-2">{grant}</code>
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
  toolCallId,
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
  const path = useLaserState((laser) => laser.current);
  const toolLabelParams = useLaserState((laser) => path ? laser.open[path]?.state.toolLabelParams : undefined);
  const visibleArgs = withoutToolLabel(args, toolName, toolLabelParams);
  const argsHaveLabel = visibleArgs !== args;
  const visibleArgsText = argsHaveLabel ? JSON.stringify(visibleArgs) : argsText;
  const agentLabel = toolDisplayLabel({ name: toolName, args }, toolLabelParams);
  const isRequiresAction = status?.type === "requires-action";
  const shouldRenderApproval = isRequiresAction && offersInterruptAction(status, approval, interrupt);
  const activityLevel = useActivityDetailLevel(path);
  const [manualOpen, rememberOpen] = useActivityDisclosureOverride(path, `tool:${toolCallId}`);
  const open = manualOpen ?? toolDetailsDefaultOpen(activityLevel);

  // M16-T60: what this window is not holding of this call is folded into the
  // output area it belongs to — the result's, or the arguments' — with the one
  // action that reads the whole of it. A tool with no typed row of its own
  // draws here, so it says the same thing `ToolRow` does.
  const bodies = (artifact as { bodies?: BlockBodies } | undefined)?.bodies;
  const outputBody = bodies?.result ?? (state === "running" ? bodies?.partial : undefined);
  const context = { toolName, command: visibleArgsText, state };
  const resultFold = omittedBytes(outputBody) > 0
    ? <BodyOverflow body={outputBody} path={path ?? undefined} label="output" ground="surface-2" finishes="the tool finishes" tool={context} fade={Boolean(result)} />
    : undefined;
  const argsFold = omittedBytes(bodies?.args) > 0
    ? <BodyOverflow body={bodies?.args} path={path ?? undefined} label="request" ground="surface-2" finishes="the tool finishes" tool={{ toolName, state }} fade={Boolean(visibleArgsText)} />
    : undefined;
  const hasBody = Boolean(visibleArgsText) || result !== undefined || status?.type === "incomplete" || Boolean(resultFold) || Boolean(argsFold);
  const tone = state === "failed" ? "danger" : state === "awaiting" ? "attention" : undefined;

  return (
    <ToolFallbackRoot
      open={open}
      onOpenChange={rememberOpen}
      tone={tone}
      visibleSearchText={agentLabel}
      bodySearchText={() => toolSearchContent({
        name: toolName,
        args,
        result: finalResult ?? (artifact as { partialOutput?: unknown } | undefined)?.partialOutput,
        isError: isError === true,
      }, toolLabelParams)}
      data-tool={toolName}
      data-status={status?.type}
    >
      <ToolFallbackTrigger
        verb={toolName}
        label={agentLabel}
        activeLabel={state === "running" ? agentLabel ?? activeToolLabel({ toolName, args }) : undefined}
        state={state}
        expandable={hasBody}
      />
      {hasBody ? (
        <ToolFallbackContent>
          <ToolFallbackError status={status} />
          <ToolFallbackArgs argsText={visibleArgsText} overflow={argsFold} className={cn(state === "cancelled" && "opacity-60")} />
          {state !== "cancelled" ? <ToolFallbackResult result={result} overflow={resultFold} /> : null}
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
