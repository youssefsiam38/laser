"use client";
/**
 * One row of a token editor — the row Settings → Appearance and Foundation
 * mode both draw (M11-T4, M21-T14).
 *
 * `docs/design-phase.md` asks for "the same token editor Laser's Settings
 * uses, on a different target". The *targets* are genuinely different: one
 * edits this app's fixed set of named colour tokens with derived values, the
 * other a DTCG document whose names, modes and aliases belong to the person's
 * product, and whose values are not all colours. What is the same, and what
 * lives here, is the row: the label, the swatch, the value field that keeps
 * its own draft while it is being typed, the contrast readout beside it, and
 * the hairline between rows.
 *
 * The draft is the part worth naming. Without it a half-typed hex is not a
 * colour, so the value snaps back on every keystroke and the field is
 * unusable; with it, what is typed stays put and is pushed up only once it is
 * something the target accepts.
 *
 * Every value here is a token. The two widths are named rather than passed as
 * classes, so a surface cannot quietly invent a third.
 */
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** How wide the label and the value field are, by what they hold. */
export type TokenRowWidth =
  /** A fixed app token name (`surface-2`) and a colour. */
  | "name"
  /** A dotted path in a document (`color.action.base`) and any value. */
  | "path";

const LABEL_WIDTH: Readonly<Record<TokenRowWidth, string>> = {
  name: "w-24 sm:w-32",
  path: "w-28 sm:w-40",
};

const FIELD_WIDTH: Readonly<Record<TokenRowWidth, string>> = {
  name: "w-24 sm:w-28",
  path: "w-32 sm:w-44",
};

export interface TokenEditorRowProps {
  /** The token's name, shown and used for both fields' labels. */
  name: string;
  /** What the name is underneath — `--surface-2`, or the custom property. */
  title?: string | undefined;
  /** The committed value this row shows when nothing is being typed. */
  value: string;
  /** The colour the swatch shows. Absent: this row has no swatch. */
  swatch?: string | undefined;
  width?: TokenRowWidth;
  /** False when this revision may be read but not edited. */
  editable?: boolean;
  first?: boolean;
  /** Whether a typed value is something the target can take. Default: anything. */
  accepts?: (value: string) => boolean;
  /** Mark a value the target cannot take as invalid, on the field itself. */
  markInvalid?: boolean;
  onCommit: (value: string) => void;
  /** The readout and chips at the end of the row. */
  status?: ReactNode;
  /** One control at the very end — "Derived", and nothing else so far. */
  action?: ReactNode;
}

export function TokenEditorRow({
  name,
  title,
  value,
  swatch,
  width = "name",
  editable = true,
  first = false,
  accepts,
  markInvalid = false,
  onCommit,
  status,
  action,
}: TokenEditorRowProps) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown = draft ?? value;
  const takeable = accepts === undefined || accepts(shown);
  const invalid = markInvalid && !takeable;

  return (
    <div data-slot="token-editor-row" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2", !first && "hairline-t")}>
      <label htmlFor={inputId} className={cn("typed shrink-0 truncate text-ink-2", LABEL_WIDTH[width])} title={title}>
        {name}
      </label>

      {swatch !== undefined ? (
        <span className="relative inline-flex size-6 shrink-0 items-center justify-center">
          <input
            id={inputId}
            type="color"
            value={swatch}
            disabled={!editable}
            aria-label={`${name} colour`}
            onChange={(event) => {
              setDraft(undefined);
              onCommit(event.target.value);
            }}
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
        aria-label={`${name} value`}
        {...(markInvalid ? { "aria-invalid": invalid } : {})}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (accepts === undefined || accepts(next)) onCommit(next);
        }}
        onBlur={() => setDraft(undefined)}
        className={cn(
          "typed h-7 shrink-0 rounded-md border bg-surface px-2 text-ink outline-none disabled:opacity-60",
          FIELD_WIDTH[width],
          "transition-[border-color] duration-(--motion-instant) motion-reduce:transition-none",
          "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
          invalid ? "border-danger" : "border-line",
        )}
      />

      {/* At a phone width the readout takes its own line rather than being
          squeezed off the end of the row: a measurement nobody can read is the
          one thing these editors exist to show. */}
      <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">{status}</span>

      {action}
    </div>
  );
}

export interface TokenContrastReadoutProps {
  /** The ratio of the value as typed, never of the one a guard would rescue. */
  ratio: number;
  /** What it has to clear: this app's floor, or the foundation's own. */
  target: number;
  /** The token it was measured against, by name. */
  against: string;
  /** What to say when it does not clear. Default: unreadable on `against`. */
  failed?: string;
}

/** `4.61:1 · on surface`, in danger when it does not clear its target. */
export function TokenContrastReadout({ ratio, target, against, failed }: TokenContrastReadoutProps) {
  const fails = ratio < target;
  return (
    <>
      <span
        className={cn("typed tnum shrink-0", fails ? "text-danger" : "text-ink-3")}
        title={`${ratio.toFixed(2)}:1 against ${against}; needs ${String(target)}:1`}
      >
        {ratio.toFixed(2)}:1
      </span>
      <span className={cn("min-w-0 truncate text-xs leading-4", fails ? "text-danger" : "text-ink-3")}>
        {fails ? (failed ?? `unreadable on ${against} — needs ${String(target)}:1`) : `on ${against}`}
      </span>
    </>
  );
}
