"use client";
/**
 * Accent and attention hue (M11-T4, T3).
 *
 * Two rows, deliberately not one control. `--live` means running and
 * `--attention` means needs-you, and the whole point of rule T3 is that those
 * two can never become the same colour. So the attention row **disables** the
 * hues that sit within `MIN_HUE_SEPARATION` of the accent and says why on the
 * disabled chip, and picking an accent that would collide moves attention out
 * of the way (`separateAttention`) instead of producing a theme the store
 * would refuse to apply.
 *
 * Each chip is drawn in the colour it would produce for the *current base*,
 * because the same hue is a different value on a dark ground and a light one.
 * The fine slider under each row is the same setting at one-degree resolution,
 * for someone who wants a hue the curated row does not name.
 */
import { useId } from "react";

import { cn } from "@/lib/utils";
import {
  ACCENT_HUES,
  accentRamp,
  attentionRamp,
  hueDistance,
  hueOf,
  MIN_HUE_SEPARATION,
  separateAttention,
  type AccentHueName,
  type ThemeBase,
} from "@/theme";

import { Swatch } from "./controls.js";

const HUE_NAMES = Object.keys(ACCENT_HUES) as AccentHueName[];

export interface HueRowProps {
  label: string;
  /** Hue in degrees, or null when the token is a grey (which the guard rejects). */
  hue: number | null;
  base: ThemeBase;
  /** How a hue becomes the colour drawn on the chip. */
  render: (hue: number, base: ThemeBase) => string;
  /**
   * The colour this row may not come near, as a value rather than a nominal
   * hue. Measuring the rendered colours is what the guard does, and a chip
   * offered on any other basis is a chip that can be pressed and then refused.
   */
  blockedAgainst?: string | undefined;
  blockedReason?: string | undefined;
  onPick: (hue: number) => void;
}

export function HueRow({ label, hue, base, render, blockedAgainst, blockedReason, onPick }: HueRowProps) {
  const labelId = useId();
  const sliderId = useId();
  const exact = hue === null ? undefined : HUE_NAMES.find((name) => Math.round(ACCENT_HUES[name]) === Math.round(hue));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span id={labelId} className="text-xs font-medium text-ink-2">
          {label}
        </span>
        <span className="typed text-ink-3">{hue === null ? "grey" : `${Math.round(hue)}°`}</span>
        {exact && <span className="text-xs text-ink-3">{exact}</span>}
      </div>

      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
        {HUE_NAMES.map((name) => {
          const value = ACCENT_HUES[name];
          const blocked = blockedAgainst !== undefined && collides(render(value, base), blockedAgainst);
          const checked = hue !== null && Math.round(value) === Math.round(hue);
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={blocked ? `${name} — ${blockedReason ?? "unavailable"}` : name}
              title={blocked ? blockedReason : name}
              disabled={blocked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onPick(value)}
              className={cn(
                "rounded-full p-0.5 outline-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                "transition-transform duration-(--motion-instant) motion-reduce:transition-none",
                blocked ? "cursor-not-allowed opacity-25" : "hover:scale-110 active:translate-y-px",
              )}
            >
              <Swatch color={render(value, base)} selected={checked} />
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor={sliderId} className="text-xs text-ink-3">
          Fine
        </label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={359}
          step={1}
          value={hue === null ? 0 : Math.round(hue)}
          onChange={(event) => onPick(Number(event.target.value))}
          className="h-1.5 w-40 max-w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-[var(--live)] outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live"
          aria-label={`${label}, degrees`}
        />
      </div>
    </div>
  );
}

/** The colour an accent hue produces on this base — what `--live` becomes. */
export function accentColor(hue: number, base: ThemeBase): string {
  return accentRamp(hue, base).text;
}

/** The colour an attention hue produces on this base. */
export function attentionColor(hue: number, base: ThemeBase): string {
  return attentionRamp(hue, base);
}

/**
 * Do these two colours read as one? Measured on the values, the way the guard
 * measures them (`checkTheme`), not on the hues they were asked for: a ramp
 * value has been through 8-bit hex, and 40° requested can measure 39.8°.
 */
export function collides(a: string, b: string): boolean {
  const ha = hueOf(a);
  const hb = hueOf(b);
  return ha !== null && hb !== null && hueDistance(ha, hb) < MIN_HUE_SEPARATION;
}

/**
 * The nearest attention hue that will actually survive the guard, given an
 * accent colour. `separateAttention` returns exactly `MIN_HUE_SEPARATION`,
 * which is a knife edge: quantise both ends to hex and the measured distance
 * can land a fraction of a degree under, so the store refuses a theme this
 * screen just offered. Stepping until the *measured* colours clear each other
 * is the only version that cannot produce a control that does nothing.
 */
export function safeAttentionHue(accent: string, wanted: number, base: ThemeBase): number {
  const accentHue = hueOf(accent);
  if (accentHue === null) return wanted;
  let hue = separateAttention(accentHue, wanted);
  for (let step = 0; step < 24; step++) {
    if (!collides(attentionRamp(hue, base), accent)) return hue;
    hue = (hue + 2) % 360;
  }
  return hue;
}
