"use client";
/**
 * One collapsed fleet row: three lines in a 320px column (leap §3 A.1–A.2).
 * Kind is a shape. Line 2 is never the task brief.
 *
 * **A row is a row.** It has no card of its own — no border, no radius, no
 * second ground inside the column's. A list of bordered cards inside a
 * bordered section inside a bordered column is three frames around two lines
 * of data; this product separates with hairlines and ground changes
 * (`DESIGN.md`, "Do not"). The list draws one hairline between siblings, the
 * nesting rail is another hairline, hover and selection are grounds, and the
 * open row is marked by a `--live` rule on its inline start.
 *
 * The three lines, and what each is for:
 *
 *   line 1  who, and how long. A command keeps its tail, because `--port 5173`
 *           is the thing a developer is looking for and `pnpm vi…` identifies
 *           nothing. Elapsed is tabular, right-aligned, and never truncates.
 *   line 2  the work's own words: the question, the activity, the last output
 *           line, the reason it ended. Never the brief.
 *   line 3  the developer strip — facts that appear nowhere else on the row.
 *           An agent's identity and spend; a command's exit state, the bytes
 *           it has written (whole, never truncated) and when it started.
 */
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { STATUS_LABEL, StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ControlHint, Hint } from "@/components/ui/hint";
import { openChanges } from "@/source-control/store.js";
import {
  FLEET_STATE_LABEL,
  agentTintIndex,
  headlineText,
  stripText,
  worktreeLabel,
  type FleetHeadline,
  type FleetItem,
  type FleetProjectedItem,
  type FleetStrip,
  type FleetWorktreeChip,
} from "@/fleet";
import { BRANCH_BUDGET, COMMAND_BUDGET, PATH_BUDGET, isPathShaped, middleTruncate, suffixTruncate } from "@/fleet/truncate.js";
import { formatBytes, formatElapsed } from "@/format";
import { cn } from "@/lib/utils";

const AGENT_TINT = [
  "bg-fleet-agent-0",
  "bg-fleet-agent-1",
  "bg-fleet-agent-2",
  "bg-fleet-agent-3",
  "bg-fleet-agent-4",
  "bg-fleet-agent-5",
  "bg-fleet-agent-6",
  "bg-fleet-agent-7",
] as const;

/**
 * The tile is 20px and no larger. It is an identity mark beside a name, not a
 * thumbnail: at 28px it was the loudest thing on a line whose job is to carry
 * a name and a duration. Its letters are the `eyebrow` utility — mono, 11px,
 * tracked, uppercase — which is the one place type goes below the 12px floor,
 * and only ever for two letters of a category, never for a value. The size is
 * never spelled as a class (`design-system.test.ts`); only the colour is
 * overridden, and colour utilities are emitted after it.
 *
 * `-mt-0.5` is optical, not arithmetic: it aligns the tile to the cap height
 * of line 1 rather than to its line box, which sits ~2px lower.
 */
export function FleetKindTile({ item, quiet = false }: { item: FleetItem; quiet?: boolean }) {
  const base = "eyebrow flex size-5 shrink-0 items-center justify-center";
  if (item.kind === "task") {
    return (
      <span
        data-slot="fleet-kind-tile"
        data-shape="square"
        aria-hidden="true"
        className={cn(base, "rounded-none", quiet ? "bg-surface-2 text-ink-3" : "bg-terminal text-terminal-ink")}
      >
        {">"}
      </span>
    );
  }
  const name = item.strip.kind === "agent" ? item.strip.agentName : item.title;
  const tint = AGENT_TINT[agentTintIndex(name)] ?? AGENT_TINT[0];
  return (
    <span
      data-slot="fleet-kind-tile"
      data-shape="round"
      aria-hidden="true"
      className={cn(base, "rounded-md font-medium", quiet ? "bg-surface-2 text-ink-3" : cn(tint, "text-on-fleet-agent"))}
    >
      {item.initials ?? "?"}
    </span>
  );
}

function TruncatedValue({
  full,
  visible,
  className,
}: {
  full: string;
  visible: string;
  className?: string;
}) {
  return (
    <span className={className} aria-label={visible !== full ? full : undefined}>
      {visible}
    </span>
  );
}

export function FleetHeadlineLine({ headline, failed }: { headline: FleetHeadline; failed: boolean }) {
  const full = headlineText(headline);
  const rest = headline.restIsPath ? middleTruncate(headline.text, PATH_BUDGET) : headline.text;
  const tone = failed ? "text-danger" : "text-ink-2";
  return (
    <span data-slot="fleet-headline" data-kind={headline.kind} className={cn("flex min-w-0 items-baseline gap-1", tone)} aria-label={full}>
      {headline.verb ? <span className="shrink-0 font-medium">{headline.verb}</span> : null}
      {headline.restIsPath ? (
        <TruncatedValue full={headline.text} visible={rest} className="typed min-w-0 truncate" />
      ) : (
        <span className="min-w-0 truncate">{headline.verb ? rest : full}</span>
      )}
    </span>
  );
}

function worktreeChipHint(chip: FleetWorktreeChip): string | undefined {
  const full = worktreeLabel(chip);
  const visible = chip.kind === "branch" ? suffixTruncate(chip.branch, BRANCH_BUDGET) : full;
  const truncated = visible !== full ? full : undefined;
  const reason = chip.reason;
  return [reason, truncated].filter((part): part is string => Boolean(part)).join("\n") || undefined;
}

function WorktreeChip({ chip }: { chip: FleetWorktreeChip }) {
  const full = worktreeLabel(chip);
  const visible = chip.kind === "branch" ? suffixTruncate(chip.branch, BRANCH_BUDGET) : full;
  const label = <TruncatedValue full={full} visible={visible} className="typed" />;
  const hint = worktreeChipHint(chip);
  return hint ? <Hint hint={hint}>{label}</Hint> : label;
}

/** Line 1's visible text. A command keeps its tail; a name keeps its start. */
function titleVisible(item: FleetItem): string {
  return item.kind === "task" ? middleTruncate(item.title, COMMAND_BUDGET) : item.title;
}

function titleHint(item: FleetItem): string | undefined {
  const visible = titleVisible(item);
  return visible === item.title ? undefined : item.title;
}

function swallowEnterOnSlot(event: KeyboardEvent<HTMLElement>, slot: string): void {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.slot === slot) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function FleetChangesButton({ runId, sessionKey }: { runId: string; sessionKey: string }) {
  const open = (): void => {
    openChanges({ scope: { kind: "agent", runId }, sessionKey });
  };
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-slot="fleet-changes"
      onClick={open}
      onKeyDown={(event) => swallowEnterOnSlot(event, "fleet-changes")}
    >
      Changes
    </Button>
  );
}

function headlineHint(headline: FleetHeadline): string | undefined {
  if (!headline.restIsPath) return undefined;
  const visible = middleTruncate(headline.text, PATH_BUDGET);
  return visible !== headline.text ? headline.text : undefined;
}

export function FleetStripLine({ strip }: { strip: FleetStrip }) {
  const full = stripText(strip);
  if (strip.kind === "agent") {
    return (
      <span data-slot="fleet-strip" data-kind="agent" className="flex min-w-0 items-baseline gap-1 text-ink-3" aria-label={full}>
        <span className="typed min-w-0 truncate">{strip.agentName}</span>
        {strip.model ? (
          <>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="typed min-w-0 truncate">{strip.model}</span>
          </>
        ) : null}
        {strip.turns !== undefined ? (
          <>
            <span aria-hidden="true" className="shrink-0">·</span>
            <span className="typed tnum min-w-0 truncate">{strip.turns}t</span>
          </>
        ) : null}
        <span aria-hidden="true" className="shrink-0">·</span>
        <span data-slot="fleet-worktree-chip" data-mode={strip.worktree.kind} className="shrink-0">
          <WorktreeChip chip={strip.worktree} />
        </span>
      </span>
    );
  }
  // Three short facts that all fit, and none of which may be cut: a truncated
  // number is not a number. They are ordered by what a developer reaches for
  // first, so if a future field ever has to go, the clock goes before the
  // bytes and the bytes before the exit state.
  const byteLabel = strip.bytes === undefined ? undefined : formatBytes(strip.bytes);
  return (
    <span data-slot="fleet-strip" data-kind="task" className="flex min-w-0 items-baseline gap-1 text-ink-3" aria-label={full}>
      <span
        data-slot="fleet-task-status"
        className={cn("typed shrink-0", strip.failed && "text-danger-quiet")}
      >
        {strip.status}
      </span>
      {byteLabel ? (
        <>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span data-slot="fleet-task-bytes" className="typed tnum shrink-0">{byteLabel}</span>
        </>
      ) : null}
      {strip.clock ? (
        <>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span data-slot="fleet-task-clock" className="typed tnum shrink-0">{strip.clock}</span>
        </>
      ) : null}
    </span>
  );
}

export function FleetWorkRow({
  item,
  expanded,
  current = false,
  onToggle,
  renderDetail,
  askingActions,
}: {
  item: FleetProjectedItem;
  expanded: boolean;
  current?: boolean;
  onToggle(): void;
  renderDetail(item: FleetItem, contextOnly: boolean): ReactNode;
  askingActions?: ReactNode | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);

  const source = item.item;
  const label = FLEET_STATE_LABEL[source.state];
  const rolledUp = item.contextOnly || item.attention !== source.own;
  const dotLabel = rolledUp ? `${STATUS_LABEL[item.attention]} below` : label;
  const headline = item.contextOnly ? undefined : source.headline;
  const elapsed = !item.contextOnly && source.elapsedMs !== undefined ? formatElapsed(source.elapsedMs) : undefined;
  const stripFull = !item.contextOnly ? stripText(source.strip) : undefined;
  const accessible = [
    dotLabel,
    source.title,
    // A context ancestor says this to a screen reader and to nobody else: on
    // screen it is one dimmed line, because a row that exists only to say
    // where you are must be the quietest thing in the column.
    item.contextOnly ? "Parent of work shown here." : headline ? headlineText(headline) : undefined,
    stripFull,
    elapsed,
    current ? "reading" : undefined,
  ]
    .filter(Boolean)
    .join(". ");
  const hint = [
    titleHint(source),
    headline ? headlineHint(headline) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n") || undefined;

  const toggle = (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={accessible}
      onClick={onToggle}
      className={cn(
        // The target grows on a finger; the paint does not. `min-h-11` on a
        // mouse would push 8px of nothing between line 2 and line 3, which is
        // the gap that made the old row look like a form.
        "flex min-w-0 w-full items-start gap-2 text-start outline-none pointer-coarse:min-h-11",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
      )}
    >
      <span className="relative -mt-0.5 shrink-0">
        <FleetKindTile item={source} quiet={item.contextOnly} />
        {/* The dot rides the tile's corner rather than taking a column of its
            own: 16px of a 288px column for a mark that belongs to the same
            identity the tile carries. */}
        <StatusDot status={item.attention} label={dotLabel} className="absolute -end-1 -top-1" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            data-slot="fleet-name"
            className={cn(
              "min-w-0 truncate text-sm leading-sm font-medium",
              source.kind === "task" && "typed font-normal",
              item.contextOnly ? "text-ink-3" : "text-ink",
            )}
          >
            {titleVisible(source)}
          </span>
          {item.contextOnly && <span className="eyebrow shrink-0 text-ink-3">context</span>}
          {current && (
            <span className="eyebrow shrink-0 text-ink-2" title="The chat you are reading">
              reading
            </span>
          )}
          {elapsed ? (
            <span data-slot="fleet-elapsed" className="ms-auto typed shrink-0 tnum text-xs leading-xs text-ink-3">
              {elapsed}
            </span>
          ) : null}
        </span>
        {!item.contextOnly && headline ? <FleetHeadlineLine headline={headline} failed={source.state === "failed"} /> : null}
      </span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none",
          expanded && "rotate-180",
        )}
      />
    </button>
  );

  const showChanges = !item.contextOnly && source.kind === "agent" && source.run !== undefined;

  return (
    <div
      ref={ref}
      data-slot="fleet-row"
      data-kind={source.kind}
      data-state={source.state}
      data-attention={item.attention}
      data-context={item.contextOnly || undefined}
      data-quiet={item.contextOnly || undefined}
      data-expanded={expanded || undefined}
      data-current={current || undefined}
      className={cn(
        // No card: no border, no radius, no inner ground. Hairlines between
        // siblings come from the list; these are grounds and one live rule.
        "relative flex min-w-0 flex-col text-ink",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "hover:bg-surface-2",
        item.contextOnly && "text-ink-3",
        (current || expanded) && "bg-surface-2",
        expanded && "before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-live before:content-['']",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
        {hint ? <ControlHint hint={hint}>{toggle}</ControlHint> : toggle}
        {/* Lines 3 and the row's controls hang below the button, indented to
            the text column (tile 20px + gap 8px) and kept clear of the
            chevron. They cannot live inside it: the worktree chip carries a
            focusable hint, and a focusable thing inside a button is neither
            valid nor reachable. */}
        {!item.contextOnly ? (
          <span className="flex min-w-0 items-baseline ps-7 pe-6">
            <FleetStripLine strip={source.strip} />
          </span>
        ) : null}
        {(showChanges || askingActions) && (
          <div
            data-slot="fleet-row-actions"
            className="flex flex-wrap items-center gap-2 ps-7 pt-1"
            onKeyDown={(event) => {
              swallowEnterOnSlot(event, "fleet-changes");
              swallowEnterOnSlot(event, "fleet-answer");
            }}
          >
            {showChanges && source.run ? (
              <FleetChangesButton runId={source.run.runId} sessionKey={source.sessionPath} />
            ) : null}
            {askingActions}
          </div>
        )}
      </div>
      {expanded && <div className="min-w-0 px-3 pb-3 hairline-t pt-3">{renderDetail(source, item.contextOnly)}</div>}
    </div>
  );
}
