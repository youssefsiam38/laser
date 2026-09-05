"use client";
/**
 * The preset gallery (M11-T3, M11-T4).
 *
 * Every card renders **in its own theme**: the preset is compiled with the
 * same function that paints the app and the result is scoped to the card, so
 * what you see in the picker is what the app becomes. No card approximates a
 * theme with a row of coloured squares.
 *
 * The specimen inside a card is the app in miniature — page ground, a surface
 * card on it, a hairline, two ranks of ink, and the three status colours —
 * because those are the decisions a preset actually makes. It is `aria-hidden`
 * and the card's accessible name carries the name and the tagline instead.
 *
 * Cards are one radio group per base. When "follow the system" is on there are
 * two live selections (the dark one and the light one), and the card for the
 * base that is not currently showing is marked as paired rather than checked —
 * it is what the app will become at dusk, not what it is now.
 */
import { useCallback, useRef } from "react";
import { Check, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ThemeBase, ThemePreset } from "@/theme";

import { themeStyle } from "./preview.js";

export interface ThemeGalleryProps {
  presets: readonly ThemePreset[];
  /** The theme currently applied. `"custom"` selects nothing. */
  activeId: string;
  activeBase: ThemeBase;
  followSystem: boolean;
  /** Preset id per base, used when following the system. */
  pair: { dark: string; light: string };
  /** True when the applied theme is a preset with hand-edited tokens on top. */
  modified: boolean;
  onPick: (id: string) => void;
}

export function ThemeGallery({ presets, activeId, activeBase, followSystem, pair, modified, onPick }: ThemeGalleryProps) {
  const dark = presets.filter((preset) => preset.base === "dark");
  const light = presets.filter((preset) => preset.base === "light");
  return (
    <div className="flex flex-col gap-4">
      <Row
        heading="Dark"
        presets={dark}
        activeId={activeId}
        pairedId={followSystem ? pair.dark : undefined}
        showPaired={followSystem && activeBase !== "dark"}
        modified={modified}
        onPick={onPick}
      />
      <Row
        heading="Light"
        presets={light}
        activeId={activeId}
        pairedId={followSystem ? pair.light : undefined}
        showPaired={followSystem && activeBase !== "light"}
        modified={modified}
        onPick={onPick}
      />
    </div>
  );
}

function Row({
  heading,
  presets,
  activeId,
  pairedId,
  showPaired,
  modified,
  onPick,
}: {
  heading: string;
  presets: readonly ThemePreset[];
  activeId: string;
  pairedId: string | undefined;
  showPaired: boolean;
  modified: boolean;
  onPick: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  const move = useCallback(
    (delta: number) => {
      const cards = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
      const from = cards.findIndex((card) => card === document.activeElement);
      const next = cards[(Math.max(0, from) + delta + cards.length) % cards.length];
      next?.focus();
    },
    [],
  );

  // Nothing in this row is checked when the applied theme belongs to the other
  // base, so the first card takes the tab stop and arrow keys do the rest.
  const checkedIndex = presets.findIndex((preset) => preset.id === activeId);

  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">{heading}</span>
      <div
        ref={container}
        role="radiogroup"
        aria-label={`${heading} themes`}
        className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        {presets.map((preset, index) => {
          const checked = preset.id === activeId;
          const paired = showPaired && preset.id === pairedId;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked || (checkedIndex < 0 && index === 0) ? 0 : -1}
              onClick={() => onPick(preset.id)}
              className={cn(
                "group relative flex flex-col overflow-hidden rounded-xl text-start outline-none",
                "border transition-[border-color,transform] duration-(--motion-fast) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                "active:translate-y-px",
                checked
                  ? "border-live"
                  : paired
                    ? "border-[color-mix(in_oklab,var(--live)_45%,var(--line))]"
                    : "border-line hover:border-[color-mix(in_oklab,var(--line)_55%,var(--ink-3))]",
              )}
            >
              <Specimen preset={preset} />
              <span className="flex items-center gap-1.5 bg-surface px-2.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {preset.name}
                    {checked && modified && <span className="text-ink-3"> · edited</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs leading-4 text-ink-3">{preset.tagline}</span>
                </span>
                {checked ? (
                  <Check aria-hidden="true" className="size-4 shrink-0 text-live" />
                ) : paired ? (
                  <Sun aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                ) : null}
              </span>
              <span className="sr-only">
                {preset.name}. {preset.tagline}
                {paired ? ` Paired with the system's ${preset.base} mode.` : ""}
                {checked && modified ? " Currently applied, with edited colours." : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The app in miniature, drawn in the preset's own tokens. Decorative: the
 * card's accessible name says everything this shows.
 */
function Specimen({ preset }: { preset: ThemePreset }) {
  return (
    <span
      aria-hidden="true"
      style={themeStyle(preset)}
      className="flex h-20 flex-col justify-between gap-1 bg-bg p-2"
    >
      <span className="flex flex-col gap-1 rounded-md border border-line bg-surface p-1.5">
        <span className="h-1.5 w-2/3 rounded-full bg-ink" />
        <span className="h-1.5 w-full rounded-full bg-ink-2 opacity-70" />
        <span className="h-1.5 w-1/2 rounded-full bg-ink-3 opacity-55" />
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-full bg-live" />
        <span className="size-2 rounded-full bg-attention" />
        <span className="size-2 rounded-full bg-danger" />
        <span className="ms-auto h-2 w-8 rounded-full bg-surface-2" />
      </span>
    </span>
  );
}
