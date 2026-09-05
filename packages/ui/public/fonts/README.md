# Typefaces

Self-hosted so the offline shell renders in the real typeface, so a captive or
flaky network cannot stall the first paint on a render-blocking cross-origin
stylesheet, and so opening piorbit on a phone does not announce itself to a
font CDN before it has drawn anything. The service worker precaches these
files (`src/pwa/vite-plugin.ts`, `PUBLIC_SHELL`).

| File | Family | Licence |
| --- | --- | --- |
| `host-grotesk-latin.woff2`, `host-grotesk-latin-ext.woff2` | Host Grotesk (variable, 400–600) | SIL Open Font License 1.1 |
| `martian-mono-latin.woff2`, `martian-mono-latin-ext.woff2` | Martian Mono (variable, 400–500) | SIL Open Font License 1.1 |

Both are the `latin` and `latin-ext` subsets as published on Google Fonts
(Host Grotesk v5, Martian Mono v6). `@font-face` and the `unicode-range` of
each subset live in `src/globals.css`; anything outside those ranges falls
through to the stacks `--font-sans` and `--font-mono` name.

To refresh them, fetch the stylesheet with a modern browser user agent and
re-download the `latin` and `latin-ext` `woff2` URLs it names:

```
https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@400;500;600&family=Martian+Mono:wght@400;500&display=swap
```
