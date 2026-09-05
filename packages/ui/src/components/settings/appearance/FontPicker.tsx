"use client";
/**
 * Interface and code font pickers (M11-T4, M11-T5).
 *
 * Every option is set in its own family, because a font name is not a font:
 * "Atkinson Hyperlegible" tells you nothing until you see the `1lI0O` it
 * draws. Each card therefore shows the family name in the family, plus a
 * specimen chosen for what actually matters at this size — mixed case, the
 * digits, and the glyphs that collide in code.
 *
 * M11-T5 says choosing a font loads only that family. So the webfonts behind
 * the *options* are not fetched when the app starts: they are fetched when
 * this picker is mounted, which only happens when someone opens Appearance
 * and expands the group. Until a family arrives the card renders in its
 * metric-matched local fallback, which is the same face the app would use, so
 * nothing reflows when it swaps.
 */
import { useEffect } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { ensureFontLoaded, fontEntry, fontStack, type FontEntry, type FontKind } from "@/theme";

/** What each specimen says. Not lorem: the glyphs that decide the choice. */
const SPECIMEN: Record<FontKind, string> = {
  sans: "Handgloves 0123 · waiting for you",
  mono: "il1I O0 {} => 3.14 · 12ms",
};

const SOURCE_LABEL: Record<FontEntry["source"], string> = {
  "self-hosted": "bundled",
  google: "Google Fonts",
  system: "no webfont",
};

export interface FontPickerProps {
  kind: FontKind;
  label: string;
  options: readonly FontEntry[];
  value: string;
  onChange: (id: string) => void;
}

export function FontPicker({ kind, label, options, value, onChange }: FontPickerProps) {
  // Mounting this picker is the moment a person is looking at the options, so
  // it is the moment the options may cost a request. Not before.
  useEffect(() => {
    for (const option of options) ensureFontLoaded(option.id, kind);
  }, [options, kind]);

  const selectedEntry = fontEntry(value, kind);
  const known = options.some((option) => option.id === value);

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={label}
        className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2"
      >
        {options.map((option) => {
          const checked = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (!known && option === options[0]) ? 0 : -1}
              onClick={() => onChange(option.id)}
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2 text-start outline-none",
                "transition-[border-color,background-color] duration-(--motion-fast) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                "active:translate-y-px",
                checked
                  ? "border-live bg-[color-mix(in_oklab,var(--live)_7%,transparent)]"
                  : "border-line hover:bg-surface-2",
              )}
            >
              <span className="flex items-center gap-1.5">
                <span
                  style={{ fontFamily: fontStack(option.id, kind) }}
                  className="min-w-0 flex-1 truncate text-base leading-6 text-ink"
                >
                  {option.family || "System"}
                </span>
                {checked && <Check aria-hidden="true" className="size-3.5 shrink-0 text-live" />}
              </span>
              <span
                style={{ fontFamily: fontStack(option.id, kind) }}
                className="truncate text-xs leading-5 text-ink-2"
              >
                {SPECIMEN[kind]}
              </span>
              {/* The note is the reason to choose this face, so it wraps
                  rather than truncating; the source is its own line so it
                  cannot be the half that gets cut. */}
              <span className="line-clamp-2 text-xs leading-4 text-ink-3">{option.note}</span>
              <span className="truncate text-xs leading-4 text-ink-3 opacity-70">{SOURCE_LABEL[option.source]}</span>
            </button>
          );
        })}
      </div>

      {!known && (
        <p className="text-xs leading-4 text-ink-3">
          Currently set to <span className="typed text-ink-2">{selectedEntry.family}</span>, which is not in this list.
          It is loaded from Google Fonts by name; picking one above replaces it.
        </p>
      )}
    </div>
  );
}
