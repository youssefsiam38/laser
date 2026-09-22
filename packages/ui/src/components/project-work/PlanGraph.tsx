"use client";
/**
 * A Plan's declared dependency graph (D-355, "Detail, by kind" → Plan:
 * "Document and Dependencies views; graph nodes carry key and state").
 *
 * Three rules this surface keeps:
 *
 * 1. **Only declared edges.** Nothing is inferred from phases, order or
 *    timing; a Plan's edges are the ones it declares (`docs/ux-elements.md`,
 *    Agent plan). A Plan with no dependencies says so rather than drawing a
 *    ladder that means nothing.
 * 2. **The host's words, not ours.** A cycle, an unknown key, a dependency
 *    outside the Plan and an orphaned Task come back from `planGraph`
 *    (M21-T15) with their own sentences and their own keys; they are rendered
 *    verbatim and the nodes they name are marked.
 * 3. **No progress.** No percentage, no bar, no "3 of 7 on track" — a
 *    dependency graph is not a schedule.
 *
 * It is a real keyboard surface: one tab stop, arrows between nodes, Enter to
 * open. The edges are SVG through the palette's own tokens; the nodes are
 * ordinary buttons, so the type never shrinks and the text never clips.
 */
import { CornerDownRight, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanBody, PlanGraphReport, ProjectWorkListItem } from "@lasercode/protocol";

import { MarkdownDocument } from "@/components/assistant-ui/elements/markdown-document";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { selectWork } from "@/project-work";
import { layoutPlanGraph, planGraphOrder, planGraphStep, type PlanGraphNode } from "@/project-work/plan-graph";
import { stateLabel } from "@/project-work/vocabulary";

import { KeyTag, StatusChip, TypeBadge } from "./KindBadge.js";
import { WorkRefusal } from "./states.js";

/**
 * Graph geometry, in CSS pixels: the box a node occupies and the room between
 * boxes. These are the layout's own coordinates — the *typography* inside a
 * node is tokens, as everywhere else — and they are declared once here so the
 * SVG edges and the HTML nodes cannot drift apart.
 */
const NODE_W = 208;
const NODE_H = 68;
const GAP_X = 56;
const GAP_Y = 12;

export function PlanGraph({
  body,
  items,
  report,
  className,
}: {
  body: PlanBody;
  items: readonly ProjectWorkListItem[];
  report: PlanGraphReport | undefined;
  className?: string;
}) {
  const layout = useMemo(() => layoutPlanGraph({ body, items, report }), [body, items, report]);
  const order = useMemo(() => planGraphOrder(layout), [layout]);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const container = useRef<HTMLDivElement>(null);

  const current = order.find((node) => node.key === focusKey) ?? order[0];

  useEffect(() => {
    if (focusKey && !order.some((node) => node.key === focusKey)) setFocusKey(undefined);
  }, [focusKey, order]);

  const focus = useCallback((key: string) => {
    setFocusKey(key);
    // Keys are `PREFIX-n`, so the attribute selector is safe; `CSS.escape` is
    // used when it exists and the key is passed through when it does not.
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(key) : key;
    container.current?.querySelector<HTMLElement>(`[data-node-key="${escaped}"]`)?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!current) return;
      const rtl = typeof document !== "undefined" && document.dir === "rtl";
      const forward = rtl ? "ArrowLeft" : "ArrowRight";
      const back = rtl ? "ArrowRight" : "ArrowLeft";
      const step =
        event.key === "ArrowDown"
          ? "down"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === forward
              ? "after"
              : event.key === back
                ? "before"
                : undefined;
      if (!step) return;
      event.preventDefault();
      const next = planGraphStep(layout, current, step);
      if (next.key !== current.key) focus(next.key);
    },
    [current, focus, layout],
  );

  const problems = report?.problems ?? [];
  const orphans = report?.orphans ?? [];

  if (layout.nodes.length === 0) {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
          This plan names no tasks yet. <span className="text-ink-3">Phases list the tasks, and a dependency joins two of them; both are written into the plan.</span>
        </p>
      </div>
    );
  }

  const width = layout.columns * NODE_W + Math.max(layout.columns - 1, 0) * GAP_X;
  const height = layout.rows * NODE_H + Math.max(layout.rows - 1, 0) * GAP_Y;
  const positions = new Map(layout.nodes.map((node) => [node.key, boxOf(node)]));

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {problems.length > 0 ? (
        <div className="flex flex-col gap-2">
          {problems.map((problem, index) => (
            // The host's own sentence, with the keys it named, in the order it
            // named them — a cycle names its first key twice, on purpose.
            <WorkRefusal
              key={`${problem.problem}-${index}`}
              message={problem.message}
              recovery={
                <span className="flex flex-wrap items-center gap-1.5">
                  {problem.keys.map((key, at) => (
                    <KeyTag key={`${key}-${at}`} workKey={key} className="text-attention" />
                  ))}
                </span>
              }
            />
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Dependencies</span>
        <span className="text-xs leading-xs text-ink-3">
          {layout.edges.length === 0
            ? "None declared. Every task here can be picked up on its own."
            : `${layout.edges.length} declared · a task sits to the right of everything it waits on.`}
        </span>
        {layout.cyclic ? <Badge variant="danger">the declared edges go round</Badge> : null}
      </div>

      <div
        ref={container}
        role="group"
        aria-label="Dependency graph"
        onKeyDown={onKeyDown}
        className="min-w-0 overflow-auto rounded-lg border border-line bg-surface p-3"
      >
        <div className="relative rtl:-scale-x-100" style={{ width, height, minWidth: width }}>
          <svg
            aria-hidden="true"
            width={width}
            height={height}
            viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
            className="pointer-events-none absolute inset-0 overflow-visible"
          >
            {layout.edges.map((edge) => {
              const from = positions.get(edge.to);
              const to = positions.get(edge.from);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={edge.problem ? "var(--danger)" : "var(--line)"}
                  strokeWidth={edge.problem ? 2 : 1.5}
                >
                  <title>
                    {edge.from} waits for {edge.to}
                    {edge.reason ? ` — ${edge.reason}` : ""}
                  </title>
                </path>
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            const box = positions.get(node.key)!;
            const waiting = layout.edges.filter((edge) => edge.from === node.key).map((edge) => edge.to);
            return (
              <button
                key={node.key}
                type="button"
                data-node-key={node.key}
                data-slot="plan-graph-node"
                tabIndex={current?.key === node.key ? 0 : -1}
                disabled={!node.entityId}
                onFocus={() => setFocusKey(node.key)}
                onClick={() => {
                  if (node.entityId) selectWork({ entityId: node.entityId, kind: node.kind });
                }}
                aria-label={`${node.key}: ${node.title}${node.state ? `, ${stateLabel(node.kind, node.state)}` : ""}${
                  waiting.length > 0 ? `, waiting on ${waiting.join(", ")}` : ""
                }${node.orphan ? ", no longer listed by this plan" : ""}`}
                className={cn(
                  "absolute flex flex-col items-start gap-1 overflow-hidden rounded-lg border p-2 text-start outline-none rtl:-scale-x-100",
                  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                  node.inProblem ? "border-danger bg-[color-mix(in_oklab,var(--danger)_8%,transparent)]" : "border-line bg-bg",
                  node.entityId ? "hover:bg-surface-2" : "cursor-default",
                  node.orphan && "border-dashed",
                )}
                style={{ insetInlineStart: box.x, top: box.y, width: NODE_W, height: NODE_H }}
              >
                <span className="flex min-w-0 max-w-full items-center gap-1.5">
                  <TypeBadge kind={node.kind} />
                  <KeyTag workKey={node.key} />
                  {node.state ? (
                    <StatusChip kind={node.kind} state={node.state} className="ms-auto" />
                  ) : (
                    <Badge variant="outline" className="ms-auto">
                      unread
                    </Badge>
                  )}
                </span>
                <span className="min-w-0 max-w-full truncate text-sm leading-5 text-ink" title={node.title}>
                  {node.title}
                </span>
                <span className="flex min-w-0 max-w-full items-center gap-1 text-xs leading-xs text-ink-3">
                  {node.orphan ? (
                    <span className="text-attention">no longer in this plan</span>
                  ) : waiting.length > 0 ? (
                    <>
                      <CornerDownRight aria-hidden="true" className="size-3 shrink-0 rtl:-scale-x-100" />
                      <span className="min-w-0 truncate">waits for {waiting.join(", ")}</span>
                    </>
                  ) : (
                    <>
                      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">{node.phase ?? "in no phase"}</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {body.dependencies.some((dependency) => dependency.reason) ? (
        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">Why these dependencies exist</h3>
          <ul role="list" className="flex flex-col gap-2">
            {body.dependencies.map((dependency, index) => dependency.reason ? (
              <li key={`${dependency.from}-${dependency.to}-${index}`} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line p-2">
                <span className="typed text-xs leading-xs text-ink-3">{dependency.from} waits on {dependency.to}</span>
                <MarkdownDocument text={dependency.reason} measure="prose" className="text-sm leading-5 text-ink-2" />
              </li>
            ) : null)}
          </ul>
        </section>
      ) : null}

      {orphans.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">No longer in this plan</h3>
          <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            These tasks still say they belong to this plan, and this revision of it no longer lists them. They keep their state and
            their links; nothing was deleted.
          </p>
          <ul role="list" className="flex flex-col gap-1">
            {orphans.map((orphan) => (
              <li key={orphan.key} className="flex min-w-0 items-center gap-2">
                <KeyTag workKey={orphan.key} />
                <span className="min-w-0 truncate text-sm leading-5 text-ink-2">{orphan.title}</span>
                <StatusChip kind="task" state={orphan.state} className="ms-auto" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const boxOf = (node: PlanGraphNode): { x: number; y: number } => ({
  x: node.column * (NODE_W + GAP_X),
  y: node.row * (NODE_H + GAP_Y),
});
