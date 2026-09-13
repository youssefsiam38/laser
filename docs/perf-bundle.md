# What the first conversation downloads

M16-T31. The renderer is one Vite build served by the host. Before this task it
was also one chunk: everything the app can do arrived before the first message
could be read — the maths typesetter, the request inspector, the template
engine, the schema library, the map's stylesheet. This document records what was
in there, what moved, what deliberately did not, and how to measure it again.

Nothing here is a guess: every number comes from the build itself or from a
browser run, and both are reproducible with the commands below.

## Reproducing the measurement

```sh
# What is in the bundle, module by module (writes packages/ui/dist-report/):
LASERCODE_BUNDLE_REPORT=1 pnpm -F @lasercode/ui build

# What a real first conversation fetches and how long the entry chunk takes to
# evaluate (medians of at least three runs; see scripts/browser-check/README.md):
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs --fixture long --script <script>
```

The report plugin is `packages/ui/src/build/bundle-report.ts`: it reads the
rendered length of every module in every chunk out of Rollup's own bundle, so
the sizes below are the bundler's, not an estimate. It is inert without the
environment variable — a normal build is byte-identical whether or not it runs —
and `dist-report/` is git-ignored.

The browser numbers come from the shared harness with the `long` fixture (240
messages, no code fences, no math), reading `PerformanceResourceTiming` for what
was fetched by the time the composer was ready and the Long Animation Frame
API's `module-script` entry for how long the entry chunk took to evaluate.

## Before and after

Source `7dac643` (main) versus this branch, same machine, same fixture, medians
of three runs each.

| | Before | After | Change |
| --- | --- | --- | --- |
| Initial JS (bytes on the wire) | 2,388,895 | 1,870,132 | −518,763 (−21.7 %) |
| Initial JS, gzipped | 713.6 kB | 562.6 kB | −151.0 kB (−21.2 %) |
| Initial CSS (bytes on the wire) | 178,113 | 132,825 | −45,288 (−25.4 %) |
| Initial CSS, gzipped | 33,100 | 22,286 | −10,814 (−32.7 %) |
| Requests before the composer is ready | 1 JS + 1 CSS | 1 JS + 1 CSS | unchanged |
| Entry chunk evaluate (ms) | 66 | 56 | −10 ms (−15 %) |
| `DOMContentLoaded` (ms) | 132 | 114 | −18 ms (−14 %) |
| JS heap after first paint (MB) | 16.5 | 15.2 | −1.3 |

Raw runs: `moduleEvaluateMs` before 65 / 66 / 69, after 56 / 55 / 58;
`domContentLoaded` before 133 / 132 / 132, after 115 / 112 / 114.

Nothing is preloaded ahead of its use: the built `dist/index.html` carries one
`<script type="module">` and one stylesheet, and no `modulepreload` link at all
(asserted in the browser check as well as read by hand).

## The initial chunk before this task: top 25 modules

"First conversation" means: the window opens, a session loads, messages are read
and one is sent. Everything else is a surface someone may never open.

| Module | Size | Needed to read and send the first message? |
| --- | --- | --- |
| `katex/dist/katex.mjs` | 586.6 KiB | No — only a message containing maths |
| `react-dom/…/react-dom-client.production.js` | 518.7 KiB | Yes |
| `zod/v3/types.js` | 119.1 KiB | No — validates the `@` file explorer's listing |
| `tailwind-merge/dist/bundle-mjs.mjs` | 99.8 KiB | Yes — every component's class merge |
| `@dnd-kit/core/dist/core.esm.js` | 91.0 KiB | No, but see "not split" below |
| `sonner/dist/index.mjs` | 67.1 KiB | Yes — errors and confirmations are toasts |
| `src/components/assistant-ui/elements/thread-list.aui.tsx` | 60.3 KiB | Yes — the sessions list |
| `src/runtime/LaserProvider.tsx` | 54.6 KiB | Yes |
| `handlebars/…/compiler/parser.js` | 47.2 KiB | No — instruction templates (agents editors) |
| `source-map/lib/source-map-consumer.js` | 40.8 KiB | No — Handlebars' dependency |
| `shiki/dist/langs-bundle-full-…mjs` | 40.3 KiB | Yes — the language catalog (loaders only) |
| `@lasercode/protocol/dist/schemas.js` | 40.0 KiB | No — with `zod`, above |
| `src/components/assistant-ui/elements/model-selector.tsx` | 36.2 KiB | Yes — the composer's model |
| `handlebars/…/compiler/javascript-compiler.js` | 36.2 KiB | No |
| `src/store.ts` | 31.7 KiB | Yes |
| `@assistant-ui/core/…/RemoteThreadListThreadListRuntimeCore.js` | 27.9 KiB | Yes |
| `mdast-util-from-markdown/lib/index.js` | 27.8 KiB | Yes — the Markdown renderer |
| `unified/lib/index.js` | 27.8 KiB | Yes |
| `src/components/shell/TelemetryPanel.tsx` | 26.7 KiB | Yes — the session's live panel |
| `@floating-ui/core` | 26.4 KiB | Yes — menus and tooltips |
| `@radix-ui/react-menu` | 25.8 KiB | Yes |
| `@floating-ui/dom` | 25.5 KiB | Yes |
| `@assistant-ui/core/…/MessageParts.js` | 25.4 KiB | Yes |
| `src/components/thread/transcript-viewport.tsx` | 25.1 KiB | Yes |
| `src/components/logs/ApiRequestDialog.tsx` | 23.0 KiB | No — the API request inspector |

By package, the four largest things a first conversation did not need were
`katex` (586.6 KiB), `handlebars` + `source-map` (275.5 KiB), `zod` +
the protocol schemas (176.2 KiB) and the inspector with its provenance marker
(43.5 KiB) — plus React Flow's stylesheet inside the initial CSS.

## What moved, and what asks for it

Each of these loads on first use behind a state that was already drawn for that
surface; none of them introduces a spinner where there was content before.

| Chunk | Loaded by | Fallback while it arrives |
| --- | --- | --- |
| `markdown-katex` (263.8 KiB, KaTeX + stylesheet) | the first message whose source contains maths (`markdown-math.ts`) | the message renders immediately; the formula typesets when the chunk lands |
| `instruction-templates` (107.1 KiB, Handlebars) | the agents editors that render an instruction template | the Agents screen's own chunk boundary |
| `explorer-listing` (79.2 KiB, zod + protocol schemas) | the first `@` listing request, in parallel with it (`use-directory-page.ts`) | the explorer's existing loading row |
| `ApiRequestDialogBody` (+ the provenance marker) | opening "View API request" | the dialog opens with its title, its capture picker and the loader it already showed while fetching a capture |
| `AgentMap` (+ React Flow's stylesheet) | opening the map for a session | the map's own "Finding this session's agents" loader, in the same box |
| `MapCanvas`, `SettingsScreen`, `AgentsScreen`, `LogsScreen`, `mermaid-diagram`, `shiki-highlighter-impl`, the Shiki grammars and themes | already split before this task | unchanged |

Two of these are not `import()` calls but tree-shaking. `@lasercode/protocol` is
one barrel, so importing any part of it reached every module it re-exports, and
Rollup keeps an unused module whenever it cannot prove the module does nothing on
import. The template vocabulary and the wire schemas were being kept that way —
by nothing. `packages/ui/vite.config.ts` declares the protocol package's dist
side-effect-free, which is what it is: types, constants and functions. Anything
that genuinely must run on import does not belong in that package.

### Shiki

One highlighter serves every fence: `react-shiki` resolves through Shiki's
`getSingletonHighlighter`, so the second fence teaches the existing instance a
new grammar instead of building a second highlighter and a second Oniguruma
engine. The full catalog is retained — every language and theme in Shiki's
bundle stays reachable — because what the entry chunk carries is the catalog of
*loaders* (40.3 KiB of `import()` thunks), not the grammars: the 300-odd grammar
chunks in `dist/assets` are fetched by the first fence that names one.
`packages/ui/test/elements/shiki-highlighter.test.ts` pins both.

## What was deliberately not split

- **`@dnd-kit/core` (91.0 KiB)** — the rail's drag-to-reorder. A drag has to be
  armed before the pointer goes down; loading the sensors on `pointerdown` would
  drop the first drag a person makes, and prefetching it on idle would be a
  chunk loaded before it is needed. It stays until the rail can arm itself
  without the library.
- **`@lobehub/icons` (132.4 KiB)** — provider marks. The composer's model chip
  shows one at first paint, so any lazy version pops a logo into place after the
  conversation is already on screen. Not worth a visible change.
- **The onboarding flow (54.7 KiB)** — for a new person this *is* the first
  conversation; delaying it to save bytes for someone who will never see it
  again is the wrong trade.
- **The core conversation path** — the Markdown renderer, the thread, the
  composer, assistant-ui, the runtime and the store are the product's first
  screen. They are not candidates.
- **`sonner`, `tailwind-merge`, `@floating-ui`, `@radix-ui/react-menu`** — used
  by the first screen.

## Regression guards

- `packages/ui/test/perf/bundle-boundaries.test.ts` walks the static import
  graph from `src/main.tsx` — the same graph the bundler turns into the first
  chunk — and fails when a heavy renderer, a split surface or a protocol value
  that drags a parser becomes statically reachable again. A helper that quietly
  imports the map or the inspector re-links it even though the `import()` beside
  it still exists, which is exactly the shape this defect takes.
- `packages/ui/test/elements/markdown-math.test.tsx` pins the maths boundary:
  every delimiter the renderer typesets is recognised, a message without maths
  never loads the chunk, a message with maths loads it once and renders typeset,
  and the next message with maths is typeset on its first paint.
- `packages/ui/test/logs/request-dialog.test.tsx` exercises the inspector
  through its lazy boundary, including its find bar — search fidelity in a
  lazily loaded surface is a test, not an assumption.
- The browser check asserts, at both widths and in both themes, that a
  conversation opens with one script and one stylesheet, that no lazy chunk is
  fetched or preloaded before it is needed, and that the explorer's validator
  and the Settings screen arrive on first use and draw their content.
