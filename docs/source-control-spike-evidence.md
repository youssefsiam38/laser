# L0 spike — `@pierre/diffs` 1.4.3 as Laser overlay renderer

Measured against Laser HEAD `8f30565c33ab75f2337c847a76c75ed1406e2ae8`. Spike lives only in `/tmp/pierre-spike/`. No Laser checkout was modified. Tokens came from compiling `packages/ui/src/theme` (default dark `laser`, default light `laser-light`); the Shiki theme is Laser's real `LASER_SHIKI_THEME` from `packages/ui/src/components/assistant-ui/elements/shiki-theme.ts`. Playwright Chromium headless 153 / Playwright 1.63. React 19.1.1, Shiki 4.4.3 (the pin).

## 1. Recommendation

**Adopt with named mitigations.** The library is a viable overlay renderer: Laser's own `var(--syntax-*)` Shiki theme recolours a rendered diff by CSS custom properties with **zero shadow-DOM mutations** (no re-highlight, no remount); its shadow roots are `open`; `CSS.highlights` paints inside them once we **append** a constructed stylesheet per root and walk `[data-line]` the same way `find-ranges.ts` walks `[data-search-content]`; selection copy of code lines is the source text with no gutter contamination. Do **not** treat it as a drop-in for every overlay state: binary and mode-only patches render an empty body; split view does **not** fall back to unified at 320px; hunk expansion is off for patch-only (`isPartial`) input; `WorkerPoolContextProvider` throws unless we pass `poolOptions.workerFactory` and `highlighterOptions`; expanding a 10 000-line split file without their `Virtualizer` dumped 20 000 DOM nodes / 6.4 MB of HTML. Those are wrappers we own, not reasons to rebuild a highlighter.

## 2. Criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Theming from Laser tokens | **pass** | `registerCustomTheme("laser", () => LASER_SHIKI_THEME)` (name must equal `theme.name`). Token spans are `style="color:var(--ink)"` / `var(--syntax-keyword)` etc. Switching `html[data-laser-theme]` dark→light recoloured 12/12 sampled spans (`rgb(195,165,249)` → `rgb(110,62,173)` for keywords) with **0** shadow mutations and the same Text nodes. Variables that carry colour: Laser `--ink`, `--syntax-*`, `--ok`, `--danger` (and Pierre chrome overrides `--diffs-*-override` on `.pierre-host`). No hex in component code. |
| 2 | Find inside Shadow DOM | **pass** | All 9 `diffs-container` roots are `mode: "open"`. Appending one `CSSStyleSheet` via `adoptedStyleSheets` (theirs stay at 1, ours make 2) + `Range`s inside each root + `CSS.highlights.set("spike-find", …)` painted: screenshot bytes of a match clip differed after clear (`880` vs `899`). `"export const"` → 17 matches across several files; next/previous stepped `added.ts` → `big.ts`. Naive per-text-node search scored **0** (tokens are split spans); concatenation per `[data-line]` is required. |
| 3 | Selection and copy | **pass** | Range over several `[data-line]` nodes, `document.execCommand("copy")`. Clipboard === selection === source (`export function greet…`) with **no** line numbers and **no** `+/-` markers. Gutter is `user-select: none` on `[data-column-number]`. Selecting from the **header** into code *does* copy `greeter.ts\n-1\n+2\n}`. A Range cannot span light DOM and a shadow tree (`crossSelected === ""`). |
| 4 | Keyboard and focus | **pass** (for overlay chrome) | Default FileDiff has **0** tabbable nodes. Tab skipped the host and landed on `#outside-button`. `keydown` for Escape / Ctrl+F / Meta+F dispatched inside the root reached `document` listeners, `target` retargeted to `DIFFS-CONTAINER`, `defaultPrevented: false`. Real Playwright keys while unfocused still hit `document`. Hunk expanders are not keyboard-operable. |
| 5 | Bundle | **partial** | One Shiki: `require.resolve("shiki")` from the app and from `@pierre/diffs` both return `node_modules/shiki/dist/index.mjs` **4.4.3**. Vite prod: **without** Pierre 309 JS chunks / 10 040 KB (index 333 KB); **with** Pierre 319 chunks / 10 815 KB (index 782 KB, **+449 KB** main, **+10** chunks). Runtime greeter load fetched **1** grammar (`typescript-*.js`), not the 300. Statically including `new Worker(new URL("@pierre/diffs/worker/worker.js"))` inflated main to **1 832 KB** and needs `worker.format = "es"`. |
| 6 | Real git patches | **partial** | Parser never threw. Added / deleted / content change / rename-changed / `\ No newline at end of file` render correctly (`[data-no-newline]` = "No newline at end of file"). Pure rename: header `moved.ts → sub/moved.ts -0+0`, **0 lines**. Mode-only (`100644`→`100755`): header `script.sh -0+0`, **0 lines**, no "executable" copy. Binary: header `logo.png -0+0`, **0 lines**, no "binary files differ". 10k-line file as a patch: collapsed hunk + "4996 unmodified lines", change visible, **instant**. Full old/new 10k split with `expandUnchanged`: **20 000** `[data-line]` nodes, **6 405 123** bytes of shadow HTML, ~0.8 s nav without workers. `WorkerPoolContextProvider` with no options throws (`langs` / `totalASTLRUCacheSize` of undefined). With `workerFactory` + `highlighterOptions`, workers work (collapsed ~201 ms; expanded ~939 ms). |
| 7 | Constraints | **partial** | 320 px split stays split: two columns **159 px**, inner content **331 px** with `data-overflow="scroll"` (no page `overflow-x`). Unified at 320 px is one column. No CSS `@keyframes`/`transition` in their sheet; `prefers-reduced-motion: reduce` vs `no-preference` screenshots were **byte-identical**. Light/dark token switch works (criterion 1). Their sheet still writes `color-scheme: dark` from the Shiki theme's `type: "dark"`; keep `options.themeType` in sync with Laser's base. |

## 3. Failures and partials — break, mitigation, cost

**C2 (not a fail, but the thing that almost was).** A match is many `<span>`s. Mitigation: concatenate text per `[data-line]`, skip `[data-gutter]` / `[data-separator]` / header — same policy as `find-ranges.ts`. Cost: a "roots" concept in find, ~80 lines, plus re-adopting the highlight sheet if React reconstructs `diffs-container` (its constructor does `adoptedStyleSheets = [sheet]`, wiping extras). Find only sees **rendered** lines: collapsed context and virtualized-offscreen lines are not in the tree. Cost: search the overlay's file model for counts, and/or expand / scroll-to-hunk before painting.

**C5 partial.** Not a second Shiki. Extra **~449 KB** of Pierre in the main chunk plus ten grammar-adjacent chunks that Shiki 4 already emits even without Pierre (~10 MB of lazy langs either way). Cost: acceptable if grammars stay lazy (measured: one grammar on greeter). Do **not** statically reference the worker URL from the overlay module unless we need the pool; that tripled the main chunk.

**C6 partial — empty bodies.** Binary, mode-only, and 100% rename parse and mount a header, then draw nothing. Mitigation: our overlay empty states (one sentence each), using metadata Pierre already parsed (`type: "rename-pure"`, `mode`/`prevMode`, `hunks.length === 0`). For a rename we want to **read**, pass `oldFile`/`newFile` or `loadDiffFiles` so the body hydrates. Cost: three designed empty states we needed anyway (F.4). Patch-only input cannot expand hunks (`isPartial: true`); feed both file sides for expandable context.

**C6 partial — 10 000 lines.** Default collapse is the right product behaviour. `expandUnchanged` without `Virtualizer`/`VirtualizedFileDiff` is not. Mitigation: use their virtualizer for the overlay body; never mount 20k line nodes. Worker pool is optional and requires `poolOptions.workerFactory` (module worker) + `highlighterOptions.langs` + custom theme passed through; unconfigured provider throws.

**C7 partial — 320 px split.** Pierre does not auto-switch to unified. Mitigation: the overlay owns the breakpoint (container query / resize) and passes `diffStyle: "unified"` plus the one-time "split doesn't fit" copy. Cost: a handful of lines we would write for our own renderer too. Inner per-column scroll at 159 px is the degradation if we forget.

**C4 nuance.** Overlay-level Escape / Ctrl+F work. In-diff hunk navigation by keyboard is ours (`expandHunk` / `handleExpandHunk` on the instance) — they are click-only.

**Theme-name trap.** `registerCustomTheme("laser-vars", () => themeNamedLaser)` throws `themeName: laser-vars does not match theme.name: laser` and the diff never paints. Register under `LASER_SHIKI_THEME.name`.

**`registerCustomCSSVariableTheme` is the worse path.** It works (also 0 mutations) but git decoration fallbacks become `#00000011` / `#00000010` because `var(--diffs-ansi-green)` is not a colour `normalizeThemeColors` can read. Prefer Laser's existing TextMate-with-`var()` theme.

## 4. Working code for criterion 2

Verbatim from `/tmp/pierre-spike/src/find-across-roots.ts`:

```ts
/**
 * Criterion 2 — find across many open shadow roots.
 *
 * `CSS.highlights` is a window-wide registry, but a `::highlight(name)` rule
 * only paints in the tree whose stylesheet carries it, and one `Range` may not
 * span two trees. So: collect every shadow root under the container, adopt one
 * constructed stylesheet into each (leaving the roots' own sheets alone), build
 * per-root ranges, and register them all in one `Highlight` per name.
 *
 * Nothing here mutates the DOM Pierre owns: no wrapper elements, no text-node
 * splitting, no attribute writes.
 */

export interface RootMatch {
  root: Document | ShadowRoot;
  range: Range;
  text: string;
}

const HIGHLIGHT_CSS = `
::highlight(spike-find) {
  background-color: color-mix(in oklab, var(--attention) 45%, transparent);
  color: var(--ink);
}
::highlight(spike-find-current) {
  background-color: var(--attention);
  color: var(--on-attention);
}
`;

let sheet: CSSStyleSheet | undefined;
function highlightSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(HIGHLIGHT_CSS);
  }
  return sheet;
}

/** Every open shadow root at or under `node`, depth-first, including nested ones. */
export function collectRoots(node: Node): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const visit = (start: Node) => {
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = start.nodeType === Node.ELEMENT_NODE ? start : walker.nextNode();
    while (current) {
      const shadow = (current as Element).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        visit(shadow);
      }
      current = walker.nextNode();
    }
  };
  visit(node);
  return roots;
}

/** Adopt the highlight stylesheet into a root, without disturbing its own sheets. */
export function adoptHighlightStyles(root: ShadowRoot): boolean {
  const sheetToAdd = highlightSheet();
  if (!("adoptedStyleSheets" in root)) return false;
  if (root.adoptedStyleSheets.includes(sheetToAdd)) return true;
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheetToAdd];
  return true;
}

const CONTENT_REGION = "[data-line]";
const SKIP = "style, script, template, [data-gutter], [data-separator], [data-diffs-header], [aria-hidden=true]";

export function rangesIn(root: Document | ShadowRoot | Element, query: string): RootMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const owner = (root as ShadowRoot).host ? (root as ShadowRoot) : document;
  type Run = { text: string; nodes: Array<{ node: Text; start: number; end: number }> };
  const runs: Run[] = [];
  let region: Element | null = null;
  let run: Run | undefined;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = (node as Text).parentElement;
    if (!parent || parent.closest(SKIP)) {
      run = undefined;
      continue;
    }
    const nextRegion = parent.closest(CONTENT_REGION) ?? (root as Element);
    if (!run || region !== nextRegion) {
      run = { text: "", nodes: [] };
      runs.push(run);
      region = nextRegion;
    }
    const value = node.textContent ?? "";
    run.nodes.push({ node: node as Text, start: run.text.length, end: run.text.length + value.length });
    run.text += value;
  }

  const matches: RootMatch[] = [];
  for (const { text, nodes } of runs) {
    const haystack = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const end = at + query.length;
      const first = nodes.find((n) => n.end > at);
      const last = nodes.find((n) => n.end >= end);
      if (first && last) {
        const range = document.createRange();
        range.setStart(first.node, at - first.start);
        range.setEnd(last.node, end - last.start);
        matches.push({ root: owner, range, text });
      }
      from = end;
    }
  }
  return matches;
}

export class ShadowFind {
  private matches: RootMatch[] = [];
  private index = 0;
  constructor(private container: Element) {}

  search(query: string) {
    const roots = collectRoots(this.container);
    let rootsStyled = 0;
    for (const root of roots) if (adoptHighlightStyles(root)) rootsStyled += 1;
    this.matches = [
      ...roots.flatMap((root) => rangesIn(root, query)),
      ...rangesIn(this.container, query).filter((m) => !insideShadow(m.range, roots)),
    ];
    this.index = 0;
    this.paint();
    return { total: this.matches.length, roots: roots.length, rootsStyled, index: this.index };
  }

  next() {
    if (!this.matches.length) return -1;
    this.index = (this.index + 1) % this.matches.length;
    this.paint();
    return this.index;
  }

  previous() {
    if (!this.matches.length) return -1;
    this.index = (this.index - 1 + this.matches.length) % this.matches.length;
    this.paint();
    return this.index;
  }

  current() { return this.matches[this.index]; }

  clear() {
    this.matches = [];
    CSS.highlights.delete("spike-find");
    CSS.highlights.delete("spike-find-current");
  }

  private paint() {
    const current = this.matches[this.index];
    const rest = this.matches.filter((_, i) => i !== this.index).map((m) => m.range);
    if (!this.matches.length) {
      CSS.highlights.delete("spike-find");
      CSS.highlights.delete("spike-find-current");
      return;
    }
    CSS.highlights.set("spike-find", new Highlight(...rest));
    CSS.highlights.set("spike-find-current", new Highlight(...(current ? [current.range] : [])));
    current?.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "auto" });
  }
}

function insideShadow(range: Range, roots: ShadowRoot[]) {
  return roots.some((root) => root.contains(range.startContainer));
}
```

Do **not** use `unsafeCSS` for this. Do **not** replace `adoptedStyleSheets` (Pierre's constructor assigns `[coreSheet]`).

## 5. Things the spec did not anticipate

**In our favour**

- Spec cited `--hls-*`. The shipped prefix is `--diffs-` (107 custom properties, including `*-override` for chrome). Better: Laser's existing Shiki theme already uses `var(--syntax-*)` / `var(--ink)` and Pierre will emit those strings as `style="color:var(--…)"`. No second theme JSON of hex.
- `parsePatchFiles` already classifies `new` / `deleted` / `rename-pure` / `rename-changed` / `change` and keeps `mode` / `prevMode`. That is the overlay's left-rail status without `parse-git-diff`.
- Split *and* stacked, word-level diffs, "N unmodified lines", no-newline marker, annotations, later editing (`edit/`, `FileDiff` accept/reject) — we would otherwise build these.
- Shadow roots are custom-element `diffs-container`, always `open`. Core CSS is an adopted sheet; theme CSS is a `<style data-theme-css>` inside the root (`:host { color: var(--ink); … }`).
- No CSS motion. `prefersReducedMotion()` only changes CodeView scroll to `"instant"`.
- Copy of code lines is already clean (gutter `user-select: none`).
- One shared highlighter per thread is their default; we will not get two Oniguruma wasm runtimes if we do not also mount `react-shiki` on the same overlay.

**Against / extra cost**

- `data-search-content` is not in their DOM. Overlay find must treat `[data-line]` as the value region (gutter is a sibling). Transcript contract stays as-is.
- Second virtualizer is real: FileDiff itself did **not** virtualize 20k expanded lines. Overlay must wrap `Virtualizer` / `VirtualizedFileDiff`.
- `color-scheme: dark` on `:host` follows the Shiki theme `type`, not Laser's light tokens, unless we pass `themeType`.
- Worker pool is not plug-and-play.
- Header chrome is selectable; a find/copy that starts in the header picks up `+/-` counts.

**Could let us delete (later, L5)** overlay-local use of `code-diff.tsx` + `diff.ts` + a patch parser. Do not delete the transcript element until the two surfaces are restyled to match (F.3 last paragraph).

## 6. Not tested, and why

- Visual judgement of the overlay as a product (leap §13: the person does that).
- `VirtualizedFileDiff` / `CodeView` virtualizer behaviour under scroll (this spike mounted `FileDiff` / `MultiFileDiff` / `PatchDiff` only).
- Edit mode, merge-conflict UI, their in-editor search panel.
- Firefox / Safari `CSS.highlights` and `adoptedStyleSheets` (Chromium only).
- Touch / phone width as a person would use it (320 px was a container width, not a device).
- Patches with commit-message preambles, combined diffs, copy detection (`-C`), submodule diffs.
- Whether a React remount of `diffs-container` drops our highlight sheet (constructor would; not exercised as a remount).
- Packaged Electron / asar (spike is Vite + Chromium).
- Concurrent two highlighters if the transcript's `react-shiki` and Pierre share one page — likely one Shiki module, not measured as a dual-mount.

## Commands

```
node tools/extract-tokens.mjs          # real Laser tokens → src/laser-tokens.json
node tools/make-css.mjs
bash tools/make-fixtures.sh            # scratch git repo under fixtures/repo
npx vite --port 5199
node tests/c1-theme.mjs
node tests/c2-find.mjs
node tests/c3-copy.mjs
node tests/c4-keyboard.mjs
node tests/c6-patches.mjs
node tests/c6-bigfull.mjs
node tests/c6-expand.mjs
node tests/c7-constraints.mjs
node tests/bundle-stub.mjs
npx vite build
```
