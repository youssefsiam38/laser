"use client";
/**
 * The token editor, pointed at a foundation (M21-T14).
 *
 * `docs/design-phase.md` asks for "the same token editor Laser's Settings
 * uses, on a different target". The rows are literally the Settings editor's
 * rows — `components/tokens/TokenEditorRow`, shared by both — with the same
 * swatch, the same value field that keeps its own draft while it is being
 * typed, and the same **contrast readout of the number you typed**, measured
 * with the same `@/theme` functions Appearance measures with. What differs is
 * only the target, and that is what this file is: Settings edits this app's
 * fixed set of named colour tokens, and this edits a DTCG document whose
 * names belong to the person's product, in the base document and in every
 * mode.
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
import { useMemo } from "react";
import type { DesignFoundation } from "@lasercode/protocol";

import { TokenContrastReadout, TokenEditorRow } from "@/components/tokens/TokenEditorRow";
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
  const editable = onChange !== undefined;
  const isColourFamily = tokenFamily(row.path) === COLOUR_FAMILY;
  const isAlias = (value: string): boolean => /^\{[^}]+\}$/.test(value.trim());
  const resolved = resolveTokenValue(foundation, row);
  const colour = parseColor(resolved) !== null;
  const measure = readout(foundation, row, resolved);

  return (
    <TokenEditorRow
      name={row.path}
      title={row.property}
      value={row.raw}
      // A dimension, a duration or a font family gets no swatch: a colour
      // chip beside `16px` would be a lie.
      {...(colour ? { swatch: toHex(resolved) } : {})}
      width="path"
      editable={editable}
      first={first}
      // A colour token takes a colour or an alias to one; everything else
      // takes whatever the person typed, because the document says what it is.
      accepts={(value) => !isColourFamily || parseColor(value) !== null || isAlias(value)}
      onCommit={(value) => onChange?.(setFoundationToken(foundation, row, value))}
      status={
        <>
          {row.alias ? <span className="shrink-0 text-xs leading-4 text-ink-3">alias</span> : null}
          {measure ? (
            <TokenContrastReadout ratio={measure.ratio} target={measure.target} against={measure.against} />
          ) : (
            <span className="min-w-0 truncate text-xs leading-4 text-ink-3">{row.type ?? "value"}</span>
          )}
        </>
      }
    />
  );
}
