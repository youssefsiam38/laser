/**
 * The kit's skin: one stylesheet, made only of custom properties.
 *
 * It is injected into every frame's shadow root, where the index's DTCG tokens
 * are set as `--design-*` custom properties (`designTokenCustomProperties`).
 * Two rules hold, and both are checked by `test/design/frame.test.tsx`:
 *
 * 1. **No static visual value.** Every colour, size, radius, shadow, duration
 *    and weight is `var(--design-…, var(--<app token>))`: the project's token
 *    when the index has one, this app's own token when it does not. A hex, a
 *    raw `px` font size or a hard-coded duration in here is a bug (AGENTS.md).
 *    The app's tokens reach the shadow root by inheritance, so an unskinned
 *    frame is still a designed surface rather than a browser default.
 * 2. **Nothing below the legibility floor.** The smallest text in the kit is
 *    `--text-xs` (12px), and a frame that cannot fit its content shows less
 *    content, never smaller text.
 *
 * The sheet is a string rather than a `CSSStyleSheet` so the same bytes work
 * in the app, in a test's headless DOM and in the exported static bundle.
 */

/** Spacing is one token times a step, so density follows the index. */
const SPACE = (step: number): string => `calc(var(--design-space-unit, var(--space-unit)) * ${String(step)})`;

export const KIT_CLASS_PREFIX = "kit-";

/**
 * The stylesheet every tree frame carries.
 *
 * `.kit-root` — the element the index's custom properties are set on — holds
 * the type and colour ground; everything else is one class per
 * kit primitive plus its variants and states, which is what the renderer
 * writes as `class="kit-button kit-button--primary is-loading"`.
 */
export function kitStyleSheet(): string {
  return `
:host {
  display: block;
  box-sizing: border-box;
}
.kit-root {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  box-sizing: border-box;
  padding: ${SPACE(4)};
  gap: ${SPACE(3)};
  font-family: var(--design-type-font-family-body, var(--font-sans));
  font-size: var(--design-type-font-size-body, var(--text-sm));
  line-height: var(--design-type-line-height-body, var(--leading-sm));
  color: var(--design-color-ink-base, var(--ink));
  background: var(--design-color-surface-page, var(--bg));
  --kit-radius: var(--design-radius-md, var(--radius));
  --kit-line: var(--design-color-line-base, var(--line));
  --kit-surface: var(--design-color-surface-base, var(--surface));
  --kit-ink-2: var(--design-color-ink-muted, var(--ink-2));
  --kit-ink-3: var(--design-color-ink-quiet, var(--ink-3));
  --kit-accent: var(--design-color-action-base, var(--live));
  --kit-on-accent: var(--design-color-action-ink, var(--on-live));
  --kit-danger: var(--design-color-danger-base, var(--danger));
  --kit-attention: var(--design-color-attention-base, var(--attention));
  --kit-ok: var(--design-color-ok-base, var(--ok));
  --kit-motion: var(--design-motion-duration-fast, var(--motion-fast));
}
*, *::before, *::after { box-sizing: inherit; }
.kit-selected { outline: var(--design-border-selected-width, 2px) solid var(--kit-accent); outline-offset: ${SPACE(0.5)}; }
.kit-node { position: relative; }

/* Layout ------------------------------------------------------------------ */
.kit-stack { display: flex; flex-direction: column; gap: ${SPACE(2)}; }
.kit-stack--row { flex-direction: row; align-items: center; }
.kit-stack--padded { padding: ${SPACE(3)}; }
.kit-stack--align-start { align-items: flex-start; }
.kit-stack--align-center { align-items: center; }
.kit-stack--align-end { align-items: flex-end; }
.kit-stack--align-stretch { align-items: stretch; }
.kit-grid { display: grid; gap: ${SPACE(2)}; grid-template-columns: repeat(var(--kit-columns, 2), minmax(0, 1fr)); }
.kit-grid--sidebar { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); }

/* Text -------------------------------------------------------------------- */
.kit-text { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.kit-text--heading { font-size: var(--design-type-font-size-heading, var(--text-lg)); line-height: var(--design-type-line-height-heading, var(--leading-lg)); font-weight: var(--design-type-font-weight-heading, 600); }
.kit-text--subheading { font-size: var(--design-type-font-size-subheading, var(--text-md)); line-height: var(--design-type-line-height-subheading, var(--leading-md)); font-weight: var(--design-type-font-weight-subheading, 600); }
.kit-text--caption { font-size: var(--design-type-font-size-caption, var(--text-xs)); line-height: var(--design-type-line-height-caption, var(--leading-xs)); color: var(--kit-ink-2); }
.kit-text--eyebrow { font-family: var(--design-type-font-family-mono, var(--font-mono)); font-size: var(--design-type-font-size-eyebrow, var(--text-xs)); line-height: var(--leading-xs); letter-spacing: var(--design-type-tracking-eyebrow, var(--tracking-eyebrow)); text-transform: uppercase; color: var(--kit-ink-3); }

/* Button ------------------------------------------------------------------ */
.kit-button {
  display: inline-flex; align-items: center; justify-content: center; gap: ${SPACE(1.5)};
  min-height: var(--design-size-control-md, ${SPACE(8)});
  padding: ${SPACE(1.5)} ${SPACE(3)};
  border: var(--design-border-width-base, 1px) solid transparent;
  border-radius: var(--kit-radius);
  font: inherit;
  font-weight: var(--design-type-font-weight-action, 500);
  background: var(--kit-accent); color: var(--kit-on-accent);
  transition: background-color var(--kit-motion) var(--motion-ease), opacity var(--kit-motion) var(--motion-ease);
}
.kit-button--secondary { background: var(--kit-surface); color: var(--design-color-ink-base, var(--ink)); border-color: var(--kit-line); }
.kit-button--ghost { background: transparent; color: var(--kit-accent); }
.kit-button--danger { background: var(--kit-danger); color: var(--design-color-danger-ink, var(--on-danger)); }
.kit-button.is-hover { filter: brightness(var(--design-state-hover-brightness, 1.08)); }
.kit-button.is-disabled { opacity: var(--design-state-disabled-opacity, 0.5); }
.kit-button.is-loading { opacity: var(--design-state-loading-opacity, 0.7); }

/* Fields ------------------------------------------------------------------ */
.kit-field { display: flex; flex-direction: column; gap: ${SPACE(1)}; min-width: 0; }
.kit-field--inline { flex-direction: row; align-items: center; gap: ${SPACE(2)}; }
.kit-label { font-size: var(--design-type-font-size-label, var(--text-xs)); line-height: var(--leading-xs); color: var(--kit-ink-2); }
.kit-control {
  min-height: var(--design-size-control-md, ${SPACE(8)});
  padding: ${SPACE(1.5)} ${SPACE(2)};
  border: var(--design-border-width-base, 1px) solid var(--kit-line);
  border-radius: var(--kit-radius);
  background: var(--kit-surface); color: var(--design-color-ink-base, var(--ink));
  font: inherit; min-width: 0;
}
.kit-control.is-focus { border-color: var(--kit-accent); box-shadow: 0 0 0 var(--design-border-focus-width, 2px) color-mix(in oklab, var(--kit-accent) 35%, transparent); }
.kit-control.is-error { border-color: var(--kit-danger); }
.kit-control.is-disabled { opacity: var(--design-state-disabled-opacity, 0.5); }
.kit-placeholder { color: var(--kit-ink-3); }
.kit-help { font-size: var(--design-type-font-size-caption, var(--text-xs)); line-height: var(--leading-xs); color: var(--kit-ink-3); }
.kit-checkbox { display: inline-flex; align-items: center; gap: ${SPACE(2)}; }
.kit-checkbox__box { width: var(--design-size-checkbox, ${SPACE(4)}); height: var(--design-size-checkbox, ${SPACE(4)}); border: var(--design-border-width-base, 1px) solid var(--kit-line); border-radius: var(--design-radius-sm, ${SPACE(1)}); display: inline-flex; align-items: center; justify-content: center; }
.kit-checkbox__box.is-checked { background: var(--kit-accent); border-color: var(--kit-accent); color: var(--kit-on-accent); }
.kit-checkbox--switch .kit-checkbox__box { width: ${SPACE(7)}; border-radius: var(--design-radius-pill, ${SPACE(4)}); justify-content: flex-start; padding: ${SPACE(0.5)}; }

/* Surfaces ---------------------------------------------------------------- */
.kit-card { display: flex; flex-direction: column; gap: ${SPACE(2)}; padding: ${SPACE(3)}; border: var(--design-border-width-base, 1px) solid var(--kit-line); border-radius: var(--kit-radius); background: var(--kit-surface); }
.kit-card--quiet { background: transparent; }
.kit-card--elevated { box-shadow: var(--design-shadow-card, var(--shadow-float-sm)); }
.kit-card__title { font-size: var(--design-type-font-size-subheading, var(--text-md)); line-height: var(--leading-md); font-weight: var(--design-type-font-weight-subheading, 600); }
.kit-card__subtitle { font-size: var(--design-type-font-size-caption, var(--text-xs)); line-height: var(--leading-xs); color: var(--kit-ink-2); }
.kit-dialog { display: flex; flex-direction: column; gap: ${SPACE(3)}; padding: ${SPACE(4)}; border: var(--design-border-width-base, 1px) solid var(--kit-line); border-radius: var(--design-radius-lg, var(--radius)); background: var(--kit-surface); box-shadow: var(--design-shadow-dialog, var(--shadow-float)); }
.kit-dialog--destructive { border-color: var(--kit-danger); }
.kit-toast { display: flex; flex-direction: column; gap: ${SPACE(0.5)}; padding: ${SPACE(2)} ${SPACE(3)}; border-radius: var(--kit-radius); border: var(--design-border-width-base, 1px) solid var(--kit-line); background: var(--kit-surface); }
.kit-toast--ok { border-inline-start: ${SPACE(0.75)} solid var(--kit-ok); }
.kit-toast--attention { border-inline-start: ${SPACE(0.75)} solid var(--kit-attention); }
.kit-toast--danger { border-inline-start: ${SPACE(0.75)} solid var(--kit-danger); }
.kit-toast--info { border-inline-start: ${SPACE(0.75)} solid var(--kit-accent); }

/* Nav and table ----------------------------------------------------------- */
.kit-nav { display: flex; gap: ${SPACE(2)}; align-items: center; }
.kit-nav--vertical { flex-direction: column; align-items: stretch; }
.kit-nav--tabs { border-bottom: var(--design-border-width-base, 1px) solid var(--kit-line); gap: ${SPACE(3)}; }
.kit-nav__item { padding: ${SPACE(1)} ${SPACE(2)}; border-radius: var(--kit-radius); color: var(--kit-ink-2); }
.kit-nav__item.is-current { color: var(--design-color-ink-base, var(--ink)); background: var(--design-color-surface-raised, var(--surface-2)); }
.kit-table { width: 100%; border-collapse: collapse; font-size: var(--design-type-font-size-body, var(--text-sm)); }
.kit-table th, .kit-table td { text-align: start; padding: ${SPACE(1.5)} ${SPACE(2)}; border-bottom: var(--design-border-width-base, 1px) solid var(--kit-line); }
.kit-table--compact th, .kit-table--compact td { padding: ${SPACE(1)} ${SPACE(1.5)}; }
.kit-table th { color: var(--kit-ink-3); font-weight: var(--design-type-font-weight-label, 500); font-size: var(--design-type-font-size-label, var(--text-xs)); line-height: var(--leading-xs); }
.kit-table--striped tbody tr:nth-child(even) { background: var(--design-color-surface-raised, var(--surface-2)); }

/* States ------------------------------------------------------------------ */
.kit-state { display: flex; flex-direction: column; align-items: center; gap: ${SPACE(1)}; padding: ${SPACE(5)} ${SPACE(3)}; text-align: center; border: var(--design-border-width-base, 1px) dashed var(--kit-line); border-radius: var(--kit-radius); }
.kit-state--inline { flex-direction: row; padding: ${SPACE(2)}; border-style: solid; text-align: start; }
.kit-state__title { font-weight: var(--design-type-font-weight-subheading, 600); }
.kit-state__detail { color: var(--kit-ink-2); font-size: var(--design-type-font-size-caption, var(--text-xs)); line-height: var(--leading-xs); }
.kit-state--error { border-color: var(--kit-danger); }
.kit-state--loading .kit-state__title { color: var(--kit-ink-2); }

/* Image ------------------------------------------------------------------- */
.kit-image { display: flex; align-items: center; justify-content: center; aspect-ratio: var(--kit-ratio, 16 / 9); background: var(--design-color-surface-raised, var(--surface-2)); border-radius: var(--design-radius-sm, ${SPACE(1)}); color: var(--kit-ink-3); font-size: var(--design-type-font-size-caption, var(--text-xs)); line-height: var(--leading-xs); overflow: hidden; }
.kit-image--rounded { border-radius: var(--kit-radius); }
.kit-image--cover { aspect-ratio: auto; height: 100%; }

@media (prefers-reduced-motion: reduce) {
  .kit-button { transition-duration: var(--motion-off, 0ms); }
}
`.trim();
}
