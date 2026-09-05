import { DESKTOP_BRIDGE } from "./api.js";
import { PRODUCT_NAME } from "@piorbit/protocol";
/**
 * The two screens that are not the app: "starting" and "cannot start".
 *
 * They exist because the alternative is a blank window, and a blank window is a
 * placeholder. Each says what is happening, what to do, and where the log is —
 * in that order, in words, with no stack trace — and both are drawn in the app's
 * own palette so they read as piorbit rather than as a browser error.
 *
 * The starting screen only appears if the host takes longer than a moment. A
 * fast start goes straight to the app, so the common case never sees a splash
 * that flashes and disappears.
 *
 * Served as a `data:` URL rather than a file so they work identically inside
 * `app.asar` and in a development run, and so there is nothing to forget to
 * copy in the build.
 */

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

export interface StatusPageContent {
  /** One line, sentence case, no full stop. */
  title: string;
  /** What is happening and what to do about it. Already written for a person. */
  message: string;
  /** Absolute path to the host log, shown small and selectable. */
  logFile: string;
  /** A working screen shows a quiet progress line instead of a button. */
  busy?: boolean;
}

export function statusPageUrl(content: StatusPageContent): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml(content))}`;
}

export function statusPageHtml({ title, message, logFile, busy = false }: StatusPageContent): string {
  // DESIGN.md tokens, both themes, no web fonts: this page renders before
  // anything has been downloaded, so it uses the platform's own UI stack.
  const action = busy
    ? `<div class="progress" role="progressbar" aria-label="Starting"><span></span></div>`
    : `<button id="retry" type="button">Try again</button>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${PRODUCT_NAME}</title>
<style>
  :root {
    --bg: #F5F7FA; --surface: #FFFFFF; --surface-2: #EEF2F6; --line: #D6DEE7;
    --ink: #131A22; --ink-2: #4A5866; --ink-3: #5F6D7B; --live: #1F6FEB;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0B0F14; --surface: #121821; --surface-2: #1A222D; --line: #263140;
      --ink: #E6EDF3; --ink-2: #9FB0C0; --ink-3: #8393A3; --live: #4DA3FF;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: grid;
    place-items: center;
    padding: 32px;
    -webkit-app-region: drag;
  }
  main {
    -webkit-app-region: no-drag;
    max-width: 46ch;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 28px 28px 24px;
  }
  .eyebrow {
    font: 500 11px/1.4 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    margin: 0 0 10px;
  }
  h1 { font-size: 19px; font-weight: 600; line-height: 1.3; margin: 0 0 10px; }
  p { margin: 0 0 14px; color: var(--ink-2); }
  .path {
    font: 12px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    color: var(--ink-3);
    overflow-wrap: anywhere;
    user-select: text;
    margin: 0;
  }
  button {
    -webkit-app-region: no-drag;
    font: 500 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #fff;
    background: var(--live);
    border: 0;
    border-radius: 8px;
    padding: 11px 16px;
    margin: 4px 0 18px;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:active { filter: brightness(0.94); }
  button:disabled { opacity: 0.6; cursor: default; filter: none; }
  button:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
  .progress {
    height: 2px;
    background: var(--surface-2);
    border-radius: 2px;
    overflow: hidden;
    margin: 6px 0 20px;
  }
  .progress span {
    display: block;
    height: 100%;
    width: 40%;
    border-radius: 2px;
    background: var(--live);
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress span { animation: none; width: 100%; opacity: 0.5; }
  }
</style>
</head>
<body>
<main>
  <p class="eyebrow">${PRODUCT_NAME}</p>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${action}
  <p class="path">Log: ${escapeHtml(logFile)}</p>
</main>
<script>
  const button = document.getElementById("retry");
  if (button) {
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Starting\\u2026";
      window.${DESKTOP_BRIDGE}?.retryHost?.();
    });
  }
</script>
</body>
</html>`;
}
