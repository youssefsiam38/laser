"use client";
/**
 * Settings → Appearance (M11-T4, and the surface M11-T3, T5, T6 and T7 are
 * reached through).
 *
 * Simple choices first, depth behind a disclosure: the gallery, then the two
 * hues, then type, then the four layout knobs, then — collapsed — every
 * semantic token with a contrast readout. Nothing here is a preview of a
 * change you then have to apply: the store writes the compiled theme to the
 * page on every keystroke, so the app *behind* this panel is the preview, and
 * there is no Apply button because there is nothing to apply.
 *
 * Three rules the code enforces rather than documents:
 *
 *  - **T3.** Choosing an accent that would collide with attention moves
 *    attention out of the way (`safeAttentionHue`); the attention row draws
 *    the colliding hues disabled and says why.
 *  - **T2.** The legibility floor is not a setting. "Small" scales the whole
 *    scale and stops at 12px for anything read as data, and the specimen says
 *    so with the measured numbers.
 *  - Editing a colour re-derives the ink that sits on it, so a new accent can
 *    never leave white-on-yellow behind on a filled button.
 *
 * The person can also carry a theme off this machine (`Copy` / `Paste`),
 * which is the seam M11-T6 lands on: the same JSON travels through the
 * settings protocol once the host has somewhere to keep it.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useCallback, useMemo, useState } from "react";
import { ChevronRight, ClipboardPaste, Copy, RotateCcw } from "lucide-react";

import { SettingsToggleRow } from "@/components/assistant-ui/elements/settings-panel";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  CODE_FONTS,
  DEFAULT_PRESET,
  INTERFACE_FONTS,
  PRESETS,
  TEXT_SCALE,
  checkTheme,
  fontEntry,
  fontStack,
  getPreset,
  hueOf,
  pickOnColor,
  presetsFor,
  scaledType,
  themeStore,
  useTheme,
  type ColorTokenName,
  type Contrast,
  type Density,
  type Motion,
  type OptionalColorTokenName,
  type Radius,
  type TextSize,
  type Theme,
  type ThemePreset,
} from "@/theme";

import { FontPicker } from "./FontPicker.js";
import { HueRow, accentColor, attentionColor, safeAttentionHue } from "./Hues.js";
import { ThemeGallery } from "./ThemeGallery.js";
import { TokenEditor } from "./TokenEditor.js";
import { Disclosure, Group, Segmented } from "./controls.js";

type TokenName = ColorTokenName | OptionalColorTokenName;

const TEXT_SIZES: ReadonlyArray<{ value: TextSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

const DENSITIES: ReadonlyArray<{ value: Density; label: string; detail: string }> = [
  { value: "comfortable", label: "Comfortable", detail: "The default spacing everywhere." },
  { value: "compact", label: "Compact", detail: "Tighter padding, so more rows fit. Text size does not change." },
];

const RADII: ReadonlyArray<{ value: Radius; label: string; detail: string }> = [
  { value: "sharp", label: "Sharp", detail: "Almost square. Reads as a console." },
  { value: "soft", label: "Soft", detail: "The default." },
  { value: "round", label: "Round", detail: "Fully rounded cards and buttons." },
];

const CONTRASTS: ReadonlyArray<{ value: Contrast; label: string; detail: string }> = [
  { value: "normal", label: "Normal", detail: "Text clears its ground by at least 4.5:1." },
  { value: "high", label: "High", detail: "Every text colour is raised until it clears its ground by 7:1." },
];

const MOTIONS: ReadonlyArray<{ value: Motion; label: string; detail: string }> = [
  { value: "full", label: "Full", detail: "Islands morph, statuses sweep, sheets slide." },
  { value: "reduced", label: "Reduced", detail: "Everything is instant. Nothing is lost but the movement." },
];

/**
 * The tokens a preset decides that no control on this screen touches. They are
 * what identifies "which preset is this, underneath the edits".
 */
const NEUTRALS = ["bg", "surface", "surface-2", "line", "ink", "ink-2", "ink-3"] as const;

/**
 * Which preset a theme came from. Editing a token turns the id into "custom",
 * which is honest but loses the answer to "custom from what" — and losing it
 * on every reload would make the per-group resets restore the wrong thing. The
 * grounds and inks answer it without storing anything: an accent edit does not
 * move them, so an exact match on all seven is the preset underneath.
 */
function originOf(theme: Theme): ThemePreset {
  const exact = getPreset(theme.id);
  if (exact) return exact;
  const match = PRESETS.find(
    (preset) => preset.base === theme.base && NEUTRALS.every((token) => preset.tokens[token] === theme.tokens[token]),
  );
  return match ?? presetsFor(theme.base)[0] ?? DEFAULT_PRESET;
}

export function AppearanceTab() {
  const { theme, base, followSystem, pair, presets, setPreset, setFollowSystem, updateTheme, setTheme, reset, textDirection, setTextDirection } =
    useTheme();

  const origin = originOf(theme);
  const modified = getPreset(theme.id) === undefined;

  const [sansOpen, setSansOpen] = useState(false);
  const [monoOpen, setMonoOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [transfer, setTransfer] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);

  const issues = useMemo(() => checkTheme(theme), [theme]);

  /**
   * The person has not chosen a typeface yet, so a preset may bring its own —
   * which is the whole point of "Midnight comes with Host Grotesk". The card's
   * own caption says which of the two is happening, because a caption that
   * promises "keeps your fonts" while the fonts change is the settings screen
   * lying about itself.
   */
  const fontsAreOrigin = theme.fonts.sans === origin.fonts.sans && theme.fonts.mono === origin.fonts.mono;

  const liveHue = hueOf(theme.tokens.live);
  const attentionHue = hueOf(theme.tokens.attention);

  const onPickPreset = useCallback(
    (id: string) => {
      // Fonts belong to the person, not the preset, unless the person has not
      // touched them — then adopting the preset's pairing is the whole point of
      // "Midnight comes with Host Grotesk".
      setPreset(id, { adoptFonts: fontsAreOrigin });
    },
    [fontsAreOrigin, setPreset],
  );

  /** Both status hues at once, so T3 can never be violated by an intermediate state. */
  const setAccent = useCallback(
    (hue: number) => {
      const live = accentColor(hue, base);
      const attention = attentionColor(safeAttentionHue(live, attentionHue ?? hue + 180, base), base);
      const darkInk = base === "dark" ? theme.tokens.bg : theme.tokens.ink;
      const lightInk = base === "dark" ? theme.tokens.ink : theme.tokens.surface;
      updateTheme({
        tokens: {
          live,
          attention,
          "on-live": pickOnColor(live, darkInk, lightInk),
          "on-attention": pickOnColor(attention, darkInk, lightInk),
        },
      });
    },
    [attentionHue, base, theme.tokens.bg, theme.tokens.ink, theme.tokens.surface, updateTheme],
  );

  const setAttention = useCallback(
    (hue: number) => {
      // The chips refuse a colliding hue; the fine slider sweeps straight
      // through the forbidden arc, so it snaps to the nearest hue that holds
      // T3 rather than sliding into a value the store would silently reject.
      const attention = attentionColor(safeAttentionHue(theme.tokens.live, hue, base), base);
      const darkInk = base === "dark" ? theme.tokens.bg : theme.tokens.ink;
      const lightInk = base === "dark" ? theme.tokens.ink : theme.tokens.surface;
      updateTheme({ tokens: { attention, "on-attention": pickOnColor(attention, darkInk, lightInk) } });
    },
    [base, theme.tokens.bg, theme.tokens.ink, theme.tokens.live, theme.tokens.surface, updateTheme],
  );

  const setToken = useCallback((token: TokenName, value: string) => updateTheme({ tokens: { [token]: value } }), [updateTheme]);

  /** Unpinning needs the key gone, not set to undefined, so the compiler derives it again. */
  const clearToken = useCallback(
    (token: TokenName) => {
      const tokens = { ...theme.tokens } as Record<string, string>;
      delete tokens[token];
      setTheme({ ...theme, id: "custom", name: "Custom", tokens: tokens as Theme["tokens"] });
    },
    [setTheme, theme],
  );

  // ------------------------------------------------------------- resets ---

  const themeIsDefault = theme.id === DEFAULT_PRESET.id && !followSystem && !modified;
  const coloursAreOrigin = useMemo(
    () => JSON.stringify(theme.tokens) === JSON.stringify(origin.tokens),
    [origin.tokens, theme.tokens],
  );
  const typeIsOrigin =
    theme.fonts.sans === origin.fonts.sans && theme.fonts.mono === origin.fonts.mono && theme.textSize === "default";
  const layoutIsOrigin =
    theme.density === origin.density &&
    theme.radius === origin.radius &&
    theme.contrast === origin.contrast &&
    theme.motion === origin.motion;

  const resetColours = useCallback(() => {
    setTheme({ ...theme, id: origin.id, name: origin.name, tokens: { ...origin.tokens } });
  }, [origin, setTheme, theme]);

  const resetType = useCallback(() => {
    updateTheme({ fonts: { ...origin.fonts }, textSize: "default" });
  }, [origin.fonts, updateTheme]);

  const resetLayout = useCallback(() => {
    updateTheme({
      density: origin.density,
      radius: origin.radius,
      contrast: origin.contrast,
      motion: origin.motion,
    });
  }, [origin.contrast, origin.density, origin.motion, origin.radius, updateTheme]);

  const resetTheme = useCallback(() => {
    setFollowSystem(false);
    setPreset(DEFAULT_PRESET.id, { adoptFonts: true });
  }, [setFollowSystem, setPreset]);

  const resetEverything = useCallback(() => {
    setTransfer(undefined);
    reset();
  }, [reset]);

  // ----------------------------------------------------------- transfer ---

  const copyTheme = useCallback(async () => {
    const text = JSON.stringify(themeStore.getState(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setTransfer("Copied. Paste it into Appearance on another machine.");
    } catch {
      setTransfer("This browser would not give the page the clipboard. Copy it from the box below instead.");
    }
  }, []);

  const pasteTheme = useCallback(async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setTransfer("This browser would not let the page read the clipboard. Paste into the box below instead.");
      return;
    }
    setTransfer(applyExported(text));
  }, []);

  const sansEntry = fontEntry(theme.fonts.sans, "sans");
  const monoEntry = fontEntry(theme.fonts.mono, "mono");
  const scale = TEXT_SCALE[theme.textSize];

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-8 px-6 py-6">
        <p className="text-xs leading-5 text-ink-3">
          Everything here changes the app behind this panel as you touch it. There is nothing to apply and nothing to
          save.
        </p>

        {/* ------------------------------------------------------- theme -- */}
        <Group
          title="Theme"
          detail={
            fontsAreOrigin
              ? followSystem
                ? "Each card is the preset, drawn in its own colours, and brings its own type. Picking one sets the theme for that side of the pair — a dark card applies when your system is dark."
                : "Each card is the preset, drawn in its own colours, and brings its own type. Once you change a font it is yours, and a preset stops replacing it."
              : followSystem
                ? "Each card is the preset, drawn in its own colours. Your fonts and sizes stay. Picking one sets the theme for that side of the pair — a dark card applies when your system is dark."
                : "Each card is the preset, drawn in its own colours. Your fonts and sizes stay."
          }
          onReset={resetTheme}
          resetDisabled={themeIsDefault}
          resetLabel={`Back to ${DEFAULT_PRESET.name}`}
        >
          <SettingsToggleRow
            id="appearance-follow-system"
            label="Follow the system"
            detail={
              followSystem
                ? `Dark: ${getPreset(pair.dark)?.name ?? "—"} · Light: ${getPreset(pair.light)?.name ?? "—"}`
                : "Switch between a dark and a light preset with the operating system."
            }
            checked={followSystem}
            onCheckedChange={setFollowSystem}
          />
          <ThemeGallery
            presets={presets}
            // A hand-edited theme has the id "custom", which would leave every
            // card unselected and no answer to "edited from what". The origin
            // card stays marked and says "edited" instead.
            activeId={modified ? origin.id : theme.id}
            activeBase={base}
            followSystem={followSystem}
            pair={pair}
            modified={modified}
            onPick={onPickPreset}
          />
        </Group>

        <Group title="Text direction" detail="Arrange the interface for the way you read. Messages keep their own text direction.">
          <Segmented
            label="Text direction"
            value={textDirection}
            options={[
              { value: "system", label: "Follow system" },
              { value: "ltr", label: "Left to right" },
              { value: "rtl", label: "Right to left" },
            ]}
            onChange={setTextDirection}
          />
        </Group>

        {/* ------------------------------------------------------ colour -- */}
        <Group
          title="Colour"
          detail="One hue means running, a different one means needs you. They can never be the same colour."
          onReset={resetColours}
          resetDisabled={coloursAreOrigin}
          resetLabel={`Back to ${origin.name}'s colours`}
        >
          <HueRow
            label="Accent — running, links, primary action"
            hue={liveHue}
            base={base}
            render={accentColor}
            onPick={setAccent}
          />
          <HueRow
            label="Attention — waiting for you"
            hue={attentionHue}
            base={base}
            render={attentionColor}
            blockedAgainst={theme.tokens.live}
            blockedReason="too close to the accent — “needs you” must never look like “running”"
            onPick={setAttention}
          />
        </Group>

        {/* -------------------------------------------------------- type -- */}
        <Group
          title="Type"
          detail="Each option is set in its own face. Opening a list is what fetches its fonts; nothing is loaded before that."
          onReset={resetType}
          resetDisabled={typeIsOrigin}
          resetLabel="Back to the preset's fonts at the default size"
        >
          <Disclosure
            label="Interface"
            value={sansEntry.family || "System sans"}
            valueStyle={{ fontFamily: fontStack(theme.fonts.sans, "sans") }}
            open={sansOpen}
            onOpenChange={setSansOpen}
          >
            <FontPicker
              kind="sans"
              label="Interface font"
              options={INTERFACE_FONTS}
              value={theme.fonts.sans}
              onChange={(id) => updateTheme({ fonts: { ...theme.fonts, sans: id } })}
            />
          </Disclosure>

          <Disclosure
            label="Code"
            value={monoEntry.family || "System monospace"}
            valueStyle={{ fontFamily: fontStack(theme.fonts.mono, "mono") }}
            open={monoOpen}
            onOpenChange={setMonoOpen}
          >
            <FontPicker
              kind="mono"
              label="Code font"
              options={CODE_FONTS}
              value={theme.fonts.mono}
              onChange={(id) => updateTheme({ fonts: { ...theme.fonts, mono: id } })}
            />
          </Disclosure>

          <Segmented
            label="Text size"
            value={theme.textSize}
            options={TEXT_SIZES}
            onChange={(value) => updateTheme({ textSize: value })}
          >
            <TypeSpecimen scale={scale} />
          </Segmented>
        </Group>

        {/* -------------------------------------------- layout and motion -- */}
        <Group
          title="Layout and motion"
          detail="How much air there is, how sharp the corners are, and how much anything moves."
          onReset={resetLayout}
          resetDisabled={layoutIsOrigin}
          resetLabel={`Back to ${origin.name}'s layout`}
        >
          <Segmented
            label="Density"
            value={theme.density}
            options={DENSITIES}
            onChange={(value) => updateTheme({ density: value })}
          />
          <Segmented
            label="Corners"
            value={theme.radius}
            options={RADII}
            onChange={(value) => updateTheme({ radius: value })}
          />
          <Segmented
            label="Contrast"
            value={theme.contrast}
            options={CONTRASTS}
            onChange={(value) => updateTheme({ contrast: value })}
          />
          <Segmented
            label="Motion"
            value={theme.motion}
            options={MOTIONS}
            onChange={(value) => updateTheme({ motion: value })}
          >
            <SystemMotionNote />
          </Segmented>
        </Group>

        {/* ---------------------------------------------- custom colours -- */}
        <Collapsible open={tokensOpen} onOpenChange={setTokensOpen}>
          <CollapsibleTrigger
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md py-1 text-start outline-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none",
                tokensOpen && "rotate-90",
              )}
            />
            <span className="text-sm font-semibold text-ink">Custom colours</span>
            <span className="text-xs text-ink-3">every token, measured</span>
            {issues.some((issue) => issue.level === "error") && (
              <span className="ms-auto text-xs font-medium text-danger">
                {issues.filter((issue) => issue.level === "error").length} not applied
              </span>
            )}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-3">
              <TokenEditor theme={theme} issues={issues} onSet={setToken} onClear={clearToken} />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* ---------------------------------------------------- transfer -- */}
        <div className="flex flex-col gap-2 hairline-t pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void copyTheme()}>
              <Copy aria-hidden="true" />
              Copy this theme
            </Button>
            <Button variant="outline" size="sm" onClick={() => void pasteTheme()}>
              <ClipboardPaste aria-hidden="true" />
              Paste a theme
            </Button>
            {/* Two presses, because this throws away a theme someone may have
                spent time on and there is no undo behind it. */}
            <Button
              variant={confirmReset ? "destructive" : "destructive-ghost"}
              size="sm"
              className="ms-auto"
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  setTransfer("This discards your theme, fonts and sizes. Press again to confirm.");
                  return;
                }
                setConfirmReset(false);
                resetEverything();
                setTransfer(`Back to ${DEFAULT_PRESET.name}.`);
              }}
              onBlur={() => setConfirmReset(false)}
              disabled={themeIsDefault && coloursAreOrigin && typeIsOrigin && layoutIsOrigin}
            >
              <RotateCcw aria-hidden="true" />
              {confirmReset ? "Discard my theme" : "Reset everything"}
            </Button>
          </div>
          <p className="text-xs leading-4 text-ink-3">
            {transfer ??
              "Your theme is saved on this desktop, so a paired phone opens wearing it too. Copy it to move it to a different machine."}
          </p>
        </div>
      </div>
    </ScrollArea>
  );
}

/**
 * The type scale at the chosen size, with the measured pixels. This is where
 * T2 is visible rather than promised: "Small" shows 12px next to the smallest
 * step and the floor holds.
 */
function TypeSpecimen({ scale }: { scale: number }) {
  const steps = [
    { step: "xs" as const, note: "values, timestamps, counts" },
    { step: "base" as const, note: "interface text" },
    { step: "md" as const, note: "transcript prose" },
  ];
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2">
      {steps.map(({ step, note }) => {
        const { size, leading } = scaledType(step, scale);
        return (
          <div key={step} className="flex items-baseline gap-2">
            <span style={{ fontSize: `${size}px`, lineHeight: `${leading}px` }} className="min-w-0 truncate text-ink">
              Handgloves 0123
            </span>
            <span className="typed tnum ms-auto shrink-0 text-ink-3">{size}px</span>
            <span className="hidden shrink-0 text-xs text-ink-3 sm:inline">{note}</span>
          </div>
        );
      })}
      <p className="mt-0.5 text-xs leading-4 text-ink-3">
        Nothing read as data goes under 12px at any size — a view that cannot fit shows less, never smaller.
      </p>
    </div>
  );
}

/** Says so when the operating system has already asked for less motion. */
function SystemMotionNote() {
  const asks =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!asks) return null;
  return (
    <p className="text-xs leading-4 text-ink-3">
      Your system asks for reduced motion, and the app already honours that. This setting only matters if you want less
      movement than the system asks for.
    </p>
  );
}

/** Adopts a pasted theme, or says exactly why it could not. */
function applyExported(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "That is not a theme — it is not JSON. Copy the whole block, including the braces.";
  }
  if (!themeStore.hydrate(parsed)) {
    return `That JSON is not a ${PRODUCT_NAME} theme, or one of its colours fails the contrast floor. Nothing changed.`;
  }
  return "Theme applied.";
}

/** Kept so a future settings transport can round-trip exactly what Copy produces. */
export function exportTheme(): string {
  return JSON.stringify(themeStore.getState(), null, 2);
}
