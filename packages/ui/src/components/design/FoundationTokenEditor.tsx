"use client";
/**
 * The token editor, pointed at a foundation (M21-T14).
 *
 * `docs/design-phase.md` asks for "the same token editor Laser's Settings
 * uses, on a different target". The rows are the Settings editor's rows —
 * swatch, value field that keeps its own draft while it is being typed, and
 * the **contrast readout of the number you typed**, measured with the same
 * `@/theme` functions Appearance measures with. What differs is only the
 * target: Settings edits this app's fixed set of named colour tokens, and
 * this edits a DTCG document whose names belong to the person's product, in
 * the base document and in every mode.
 *
 * A colour is measured against the foundation's own ground and ink — a
 * product's `color.ink` has to clear the product's `color.bg`, not Laser's —
 * and against the accessibility floor the foundation itself records. An alias
 * (`{color.neutral.900}`) is resolved before it is measured, and shown as the
 * alias it is.
 *
 * Nothing that is not a colour is guessed at: a dimension, a duration or a
 * font family is a plain text field, because a swatch beside `16px` would be
 * a lie.
 */
import { useId, useMemo, useState } from "react";
import type { DesignFoundation } from "@lasercode/protocol";

import { cn } from "@/lib/utils";
import { contrastRatio, MIN_CONTRAST, parseColor, toHex } from "@/theme";
import { foundationTokenRows, resolveTokenValue, setFoundationToken, tokenFamily, type FoundationTokenRow } from "@/design/foundation";

export interface FoundationTokenEditorProps {
  foundation: DesignFoundation;
  /** Absent when the person may read but not edit; rows go read-only. */
  onChange?: ((next: DesignFoundation) => void) | undefined;
  /** Why editing is off, said once above the rows. */
  readOnlyReason?: string | undefined;
  /** Only these families, when a step wants to show its own. */
  families?: readonly string[] | undefined;
}

const COLOUR_FAMILY = "color";

export function FoundationTokenEditor({ foundation, onChange, readOnlyReason, families }: FoundationTokenEditorProps) {
  const rows = useMemo(() => foundationTokenRows(foundation), [foundation]);
  const shown = families ? rows.filter((row) => families.includes(tokenFamily(row.path))) : rows;
  const groups = useMemo(() => {
    const byGroup = new Map<string, FoundationTokenRow[]>();
    for (const row of shown) {
      const key = row.owner.kind === "base" ? tokenFamily(row.path) : `${row.owner.name} · ${tokenFamily(row.path)}`;
      byGroup.set(key, [...(byGroup.get(key) ?? []), row]);
    }
    return [...byGroup.entries()];
  }, [shown]);

  if (rows.length === 0) {
    return (
      <p role="status" className="text-xs leading-xs text-ink-3">
        This foundation has no tokens yet. They arrive with the primitive tokens step.
      </p>
    );
  }

  return (
    <div data-slot="foundation-token-editor" className="flex flex-col gap-4">
      {readOnlyReason && !onChange ? (
        <p role="status" className="text-xs leading-xs text-ink-3">
          {readOnlyReason}
        </p>
      ) : null}
      {groups.map(([name, list]) => (
        <div key={name} role="group" aria-label={name} className="flex flex-col gap-1.5">
          <h5 className="typed text-ink-2">{name}</h5>
          <div className="flex flex-col rounded-lg border border-line">
            {list.map((row, index) => (
              <TokenRow
                key={`${row.owner.kind === "base" ? "base" : row.owner.name}:${row.path}`}
                row={row}
                foundation={foundation}
                first={index === 0}
                onChange={onChange}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** What this colour has to clear, and whether it does. */
function readout(
  foundation: DesignFoundation,
  row: FoundationTokenRow,
  resolved: string,
): { ratio: number; target: number; against: string } | undefined {
  if (tokenFamily(row.path) !== COLOUR_FAMILY || parseColor(resolved) === null) return undefined;
  const target = foundation.accessibility?.contrastMin ?? MIN_CONTRAST;
  const rows = foundationTokenRows(foundation);
  const owner = row.owner;
  const sameOwner = rows.filter((candidate) => (owner.kind === "base" ? candidate.owner.kind === "base" : candidate.owner.kind === "mode" && candidate.owner.name === owner.name));
  const pool = sameOwner.length > 0 ? sameOwner : rows;
  const grounds = pool.filter((candidate) => /(^|\.)(bg|background|surface|surface-\w+|canvas|ground)$/.test(candidate.path));
  const inks = pool.filter((candidate) => /(^|\.)(ink|ink-\w+|text|foreground|on-\w+)$/.test(candidate.path));

  // A ground is measured against the ink that sits on it; everything else is
  // measured against the grounds, at its worst.
  const isGround = grounds.some((candidate) => candidate.path === row.path);
  const others = isGround ? inks : grounds;
  if (others.length === 0) return undefined;
  let worst = Number.POSITIVE_INFINITY;
  let against = "";
  for (const other of others) {
    const value = resolveTokenValue(foundation, other);
    if (parseColor(value) === null) continue;
    const ratio = contrastRatio(resolved, value);
    if (ratio < worst) {
      worst = ratio;
      against = other.path;
    }
  }
  return Number.isFinite(worst) ? { ratio: worst, target, against } : undefined;
}

function TokenRow({
  row,
  foundation,
  first,
  onChange,
}: {
  row: FoundationTokenRow;
  foundation: DesignFoundation;
  first: boolean;
  onChange?: ((next: DesignFoundation) => void) | undefined;
}) {
  const inputId = useId();
  // The field keeps its own draft while it is being typed: a half-typed hex is
  // not a colour, and snapping the value back on every keystroke would make
  // the field unusable. The draft is pushed up as soon as it parses.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown = draft ?? row.raw;
  const resolved = resolveTokenValue(foundation, { ...row, raw: shown, alias: /^\{[^}]+\}$/.test(shown.trim()) });
  const colour = parseColor(resolved) !== null;
  const measure = readout(foundation, row, resolved);
  const fails = measure !== undefined && measure.ratio < measure.target;
  const editable = onChange !== undefined;

  const commit = (value: string): void => {
    setDraft(value);
    if (!editable) return;
    if (tokenFamily(row.path) !== COLOUR_FAMILY || parseColor(value) !== null || /^\{[^}]+\}$/.test(value.trim())) {
      onChange(setFoundationToken(foundation, row, value));
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2", !first && "hairline-t")}>
      <label htmlFor={inputId} className="typed w-28 shrink-0 truncate text-ink-2 sm:w-40" title={row.property}>
        {row.path}
      </label>

      {colour ? (
        <span className="relative inline-flex size-6 shrink-0 items-center justify-center">
          <input
            id={inputId}
            type="color"
            value={toHex(resolved)}
            disabled={!editable}
            aria-label={`${row.path} colour`}
            onChange={(event) => commit(event.target.value)}
            className={cn(
              "size-6 cursor-pointer rounded-md border border-line bg-transparent p-0 outline-none disabled:cursor-not-allowed disabled:opacity-60",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
              "[&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0",
              "[&::-webkit-color-swatch-wrapper]:p-0.5",
            )}
          />
        </span>
      ) : null}

      <input
        type="text"
        value={shown}
        spellCheck={false}
        autoComplete="off"
        disabled={!editable}
        aria-label={`${row.path} value`}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => setDraft(undefined)}
        className={cn(
          "typed h-7 w-32 shrink-0 rounded-md border border-line bg-surface px-2 text-ink outline-none disabled:opacity-60 sm:w-44",
          "transition-[border-color] duration-(--motion-instant) motion-reduce:transition-none",
          "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
        )}
      />

      <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
        {row.alias ? <span className="shrink-0 text-xs leading-4 text-ink-3">alias</span> : null}
        {measure ? (
          <>
            <span className={cn("typed tnum shrink-0", fails ? "text-danger" : "text-ink-3")} title={`${measure.ratio.toFixed(2)}:1 against ${measure.against}; needs ${String(measure.target)}:1`}>
              {measure.ratio.toFixed(2)}:1
            </span>
            <span className={cn("min-w-0 truncate text-xs leading-4", fails ? "text-danger" : "text-ink-3")}>
              {fails ? `unreadable on ${measure.against} — needs ${String(measure.target)}:1` : `on ${measure.against}`}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate text-xs leading-4 text-ink-3">{row.type ?? "value"}</span>
        )}
      </span>
    </div>
  );
}
