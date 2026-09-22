"use client";
/**
 * The node inspector (M21-T11, `docs/design-phase.md` Case B).
 *
 * What a person can do to a node is exactly what the kit contract lists for
 * it: its props, its variants, its states, its text, its place among its
 * siblings. A token prop takes only a token the index has — a free value is
 * **refused with the nearest token suggested**, and the suggestion is one
 * press away. Nothing here can write a value the renderer would have to
 * interpret, which is why the design stays composed rather than styled.
 *
 * For a node drawn from the index, the inspector shows the entry: its era,
 * its confidence, its review state, and its sources with "open source file"
 * — because a Mapped node is a claim about the project, and a claim shows its
 * evidence.
 */
import { ArrowDown, ArrowUp, ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesignBody, DesignIndexEntry, DesignNode, DesignPropValue, DesignScreen, FlatDesignToken } from "@lasercode/protocol";
import { validateDesignTree } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { openSourcePath } from "@/components/ui/source-file-link";
import { selectClass } from "@/components/settings/fields";
import { cn } from "@/lib/utils";
import { kitNameForEntry, kitPrimitive, KIT_NAMES, type KitProp } from "@/design/kit";
import { refuseFreeValue, tokenFamilies, tokenValueLabel, type FreeValueRefusal } from "@/design/tokens";
import { ancestry, nodeLabel, nudgeNode, parentOf, setNodeProp, setNodeState, setNodeText, setNodeVariant, treeOf } from "@/design/tree-model";

import { FIDELITY_LABEL, FIDELITY_TONE } from "./ScreenFrame.js";

const CONFIDENCE_TONE = { declared: "ok", observed: "live", inferred: "attention", proposed: "outline" } as const;
const REVIEW_LABEL: Readonly<Record<DesignIndexEntry["review"]["state"], string>> = {
  unreviewed: "Unreviewed",
  accepted: "Accepted",
  renamed: "Renamed",
  merged: "Merged",
  split: "Split",
  rejected: "Rejected",
};

export interface NodeInspectorProps {
  body: DesignBody;
  screen: DesignScreen;
  node: DesignNode;
  tokens: readonly FlatDesignToken[];
  entry?: DesignIndexEntry | undefined;
  editable: boolean;
  readOnlyReason?: string | undefined;
  /** Every edit is a whole new body; the detail decides when to write it. */
  onChange: (body: DesignBody) => void;
  onSelect?: ((nodeId: string) => void) | undefined;
}

export function NodeInspector({ body, screen, node, tokens, entry, editable, readOnlyReason, onChange, onSelect }: NodeInspectorProps) {
  const tree = treeOf(screen);
  const primitiveName = "primitive" in node.component ? node.component.primitive : kitNameForEntry(entry?.name ?? node.component.indexEntryId, entry?.detail);
  const primitive = kitPrimitive(primitiveName);
  const parent = tree ? parentOf(tree, node.id) : undefined;
  const siblings = parent?.children ?? [];
  const position = siblings.indexOf(node.id);
  const crumbs = tree ? ancestry(tree, node.id) : [];
  const issues = tree
    ? validateDesignTree(tree, { tokenIds: tokens.map((token) => token.path), primitives: KIT_NAMES }).issues.filter((issue) =>
        issue.path.includes(`[${String(tree.nodes.findIndex((candidate) => candidate.id === node.id))}]`),
      )
    : [];

  const disabled = !editable;

  return (
    <div data-slot="design-node-inspector" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        {crumbs.length > 1 ? (
          <nav aria-label="Where this node is" className="flex min-w-0 flex-wrap items-center gap-1 text-xs leading-xs text-ink-3">
            {crumbs.slice(0, -1).map((ancestor) => (
              <span key={ancestor.id} className="flex items-center gap-1">
                <button type="button" className="rounded hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live" onClick={() => onSelect?.(ancestor.id)}>
                  {nodeLabel(ancestor, "primitive" in ancestor.component ? ancestor.component.primitive : "component")}
                </button>
                <span aria-hidden="true">›</span>
              </span>
            ))}
          </nav>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{entry?.name ?? primitive?.label ?? primitiveName}</h3>
          <Badge variant={FIDELITY_TONE[node.fidelity]}>{FIDELITY_LABEL[node.fidelity]}</Badge>
          {node.unreviewed === true || entry?.review.state === "unreviewed" ? <Badge variant="attention">unreviewed</Badge> : null}
        </div>
        <p className="text-xs leading-xs text-ink-2">{primitive?.purpose ?? "A component from the project's index, drawn by the closest kit primitive."}</p>
        <span className="typed text-ink-3">{node.id}</span>
      </header>

      {readOnlyReason ? (
        <p role="status" className="rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
          {readOnlyReason}
        </p>
      ) : null}

      {issues.length > 0 ? (
        <ul role="list" aria-label="Problems with this node" className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.path}`} className="rounded-md border border-danger/40 px-2 py-1.5 text-xs leading-xs text-ink-2">
              {issue.message}
              {issue.suggestion ? <span className="typed ms-1 text-ink-3">{issue.suggestion}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {entry ? <EntryCard entry={entry} /> : null}

      {primitive?.inlineText === true || node.text !== undefined ? (
        <Field label="Text">
          <Textarea
            aria-label="Text"
            value={node.text ?? ""}
            disabled={disabled}
            rows={2}
            onChange={(event) => onChange(setNodeText(body, screen.id, node.id, event.target.value))}
          />
        </Field>
      ) : null}

      {primitive && primitive.variants.length > 1 ? (
        <Field label="Variant">
          <select
            aria-label="Variant"
            className={selectClass}
            value={node.variant ?? primitive.variants[0] ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(setNodeVariant(body, screen.id, node.id, event.target.value === primitive.variants[0] ? undefined : event.target.value))}
          >
            {primitive.variants.map((variant) => (
              <option key={variant} value={variant}>
                {variant}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {primitive && primitive.states.length > 0 ? (
        <Field label="State">
          <select
            aria-label="State"
            className={selectClass}
            value={node.state ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(setNodeState(body, screen.id, node.id, event.target.value === "" ? undefined : event.target.value))}
          >
            <option value="">— as designed —</option>
            {primitive.states.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {primitive && primitive.props.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h4 className="eyebrow">Props</h4>
          {primitive.props.map((prop) => (
            <PropField
              key={prop.name}
              prop={prop}
              value={node.props[prop.name]}
              tokens={tokens}
              fixtures={body.fixtures}
              disabled={disabled}
              onCommit={(value) => onChange(setNodeProp(body, screen.id, node.id, prop.name, value))}
            />
          ))}
        </div>
      ) : null}

      {parent && siblings.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="eyebrow">Order</h4>
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" disabled={disabled || position <= 0} onClick={() => onChange(nudgeNode(body, screen.id, node.id, -1))}>
              <ArrowUp />
              Earlier
            </Button>
            <Button size="xs" variant="outline" disabled={disabled || position >= siblings.length - 1} onClick={() => onChange(nudgeNode(body, screen.id, node.id, 1))}>
              <ArrowDown />
              Later
            </Button>
            <span className="typed tnum text-ink-3">
              {position + 1} of {siblings.length}
            </span>
          </div>
          <p className="text-xs leading-xs text-ink-3">Or drag it among its siblings on the canvas. Alt with an arrow does the same from the keyboard.</p>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string | undefined }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs leading-xs text-ink-2">{label}</span>
      {children}
      {hint ? <span className="text-xs leading-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

function EntryCard({ entry }: { entry: DesignIndexEntry }) {
  return (
    <section aria-label="Index entry" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="mono">{entry.kind}</Badge>
        <Badge variant={CONFIDENCE_TONE[entry.confidence]}>{entry.confidence}</Badge>
        <Badge variant={entry.review.state === "accepted" ? "ok" : entry.review.state === "rejected" ? "danger" : entry.review.state === "unreviewed" ? "attention" : "outline"}>
          {REVIEW_LABEL[entry.review.state]}
        </Badge>
        {entry.changedSinceReview === true ? <Badge variant="attention">changed since review</Badge> : null}
        {entry.status === "deprecated" ? <Badge variant="outline">deprecated</Badge> : null}
      </span>
      {entry.summary ? <p className="text-xs leading-xs text-ink-2">{entry.summary}</p> : null}
      {entry.sources.length > 0 ? (
        <ul role="list" className="flex flex-col gap-0.5">
          {entry.sources.map((source) => (
            <li key={source.path} className="flex min-w-0 items-center gap-1.5">
              <span className="typed min-w-0 truncate text-ink-3" title={source.path}>
                {source.path}
              </span>
              <Button size="icon-xs" variant="ghost" aria-label={`Open ${source.path}`} onClick={() => void openSourcePath(source.path)}>
                <ExternalLink />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-xs text-ink-3">This entry cites no source file.</p>
      )}
    </section>
  );
}

function PropField({
  prop,
  value,
  tokens,
  fixtures,
  disabled,
  onCommit,
}: {
  prop: KitProp;
  value: DesignPropValue | undefined;
  tokens: readonly FlatDesignToken[];
  fixtures: DesignBody["fixtures"];
  disabled: boolean;
  onCommit: (value: DesignPropValue | undefined) => void;
}) {
  switch (prop.kind) {
    case "text":
      return (
        <Field label={prop.label} hint={prop.hint}>
          <Input
            aria-label={prop.label}
            value={value?.type === "text" ? value.value : ""}
            disabled={disabled}
            onChange={(event) => onCommit(event.target.value === "" ? undefined : { type: "text", value: event.target.value })}
          />
        </Field>
      );
    case "number":
      return (
        <Field label={prop.label} hint={prop.hint}>
          <Input
            aria-label={prop.label}
            type="number"
            inputMode="numeric"
            value={value?.type === "number" ? String(value.value) : ""}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number.parseFloat(event.target.value);
              onCommit(Number.isFinite(parsed) ? { type: "number", value: parsed } : undefined);
            }}
          />
        </Field>
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm leading-5 text-ink">
          <input
            type="checkbox"
            aria-label={prop.label}
            checked={value?.type === "boolean" ? value.value : false}
            disabled={disabled}
            onChange={(event) => onCommit({ type: "boolean", value: event.target.checked })}
            className="size-4 accent-live"
          />
          {prop.label}
        </label>
      );
    case "choice":
      return (
        <Field label={prop.label} hint={prop.hint}>
          <select
            aria-label={prop.label}
            className={selectClass}
            value={value?.type === "choice" ? value.value : ""}
            disabled={disabled}
            onChange={(event) => onCommit(event.target.value === "" ? undefined : { type: "choice", value: event.target.value })}
          >
            <option value="">— not set —</option>
            {(prop.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </Field>
      );
    case "fixture":
      return (
        <Field label={prop.label} hint={prop.hint ?? "Rows come from a fixture on this revision."}>
          <select
            aria-label={prop.label}
            className={selectClass}
            value={value?.type === "fixture" ? value.fixtureId : ""}
            disabled={disabled || fixtures.length === 0}
            onChange={(event) => onCommit(event.target.value === "" ? undefined : { type: "fixture", fixtureId: event.target.value })}
          >
            <option value="">{fixtures.length === 0 ? "This revision has no fixtures yet" : "— not bound —"}</option>
            {fixtures.map((fixture) => (
              <option key={fixture.id} value={fixture.id}>
                {fixture.name} · {fixture.rows} rows
              </option>
            ))}
          </select>
        </Field>
      );
    case "asset":
      return (
        <Field label={prop.label} hint={prop.hint ?? "An asset handle from the project's index; never a URL."}>
          <Input
            aria-label={prop.label}
            value={value?.type === "asset" ? value.assetId : ""}
            disabled={disabled}
            onChange={(event) => onCommit(event.target.value === "" ? undefined : { type: "asset", assetId: event.target.value })}
          />
        </Field>
      );
    case "token":
      return <TokenField prop={prop} value={value} tokens={tokens} disabled={disabled} onCommit={onCommit} />;
  }
}

/**
 * The token field: an input with the index's tokens as suggestions, and the
 * refusal a free value gets. Commit happens on blur and Enter so the person
 * can type a whole value before being told about it.
 */
export function TokenField({
  prop,
  value,
  tokens,
  disabled,
  onCommit,
}: {
  prop: KitProp;
  value: DesignPropValue | undefined;
  tokens: readonly FlatDesignToken[];
  disabled: boolean;
  onCommit: (value: DesignPropValue | undefined) => void;
}) {
  const current = value?.type === "token" ? value.tokenId : "";
  const [draft, setDraft] = useState(current);
  const [refusal, setRefusal] = useState<FreeValueRefusal | undefined>(undefined);
  useEffect(() => {
    setDraft(current);
    setRefusal(undefined);
  }, [current]);

  const family = prop.tokenFamily ? tokenFamilies(tokens).find((group) => group.family === prop.tokenFamily) : undefined;
  const offered = family?.tokens ?? tokens;
  const listId = `design-tokens-${prop.name}`;

  const commit = (): void => {
    const wanted = draft.trim();
    if (wanted.length === 0) {
      setRefusal(undefined);
      onCommit(undefined);
      return;
    }
    const refused = refuseFreeValue(wanted, tokens);
    if (refused) {
      setRefusal(refused);
      return;
    }
    setRefusal(undefined);
    onCommit({ type: "token", tokenId: wanted });
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={prop.label} hint={prop.hint}>
        <Input
          aria-label={prop.label}
          list={listId}
          value={draft}
          disabled={disabled}
          aria-invalid={refusal ? true : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className={cn(refusal && "border-danger")}
        />
      </Field>
      <datalist id={listId}>
        {offered.map((token) => (
          <option key={token.path} value={token.path}>
            {tokenValueLabel(token)}
          </option>
        ))}
      </datalist>
      {refusal ? (
        <div role="alert" data-slot="free-value-refusal" className="flex flex-col gap-1.5 rounded-md border border-danger/40 px-2 py-1.5">
          <p className="text-xs leading-xs text-ink-2">{refusal.message}</p>
          {refusal.suggestion ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() => {
                const suggestion = refusal.suggestion;
                if (!suggestion) return;
                setDraft(suggestion.path);
                setRefusal(undefined);
                onCommit({ type: "token", tokenId: suggestion.path });
              }}
            >
              <Sparkles />
              Use {refusal.suggestion.path}
              <span className="typed text-ink-3">{tokenValueLabel(refusal.suggestion)}</span>
            </Button>
          ) : null}
        </div>
      ) : current ? (
        <span className="typed text-ink-3">{tokenValueLabel(tokens.find((token) => token.path === current) ?? { path: current, property: "", value: "not in the index" })}</span>
      ) : null}
    </div>
  );
}
