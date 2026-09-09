import { DESKTOP_BRIDGE } from "./api.js";
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME } from "@lasercode/protocol";
import { startupScreenPageHtml } from "@lasercode/protocol/startup-screen";
import { activeGround, groundPair, type StartupGround } from "./startup-ground.js";
/**
 * The two screens that are not the app: "starting" and "cannot start".
 *
 * They exist because the alternative is a blank window, and a blank window is a
 * placeholder. "Cannot start" says what happened, what to do, and where the log
 * is, in that order, in words, with no stack trace. (Its palette is still the
 * one this file was written with, which predates the theme system; it is not a
 * loader and was deliberately left alone here.)
 *
 * "Starting" is not a screen of its own any more (M13-T32). It is the app's own
 * opening screen — the mark with the beams — drawn from
 * `@lasercode/protocol/startup-screen`, the same composition the renderer
 * mounts, in the person's own recorded colours. There is one opening screen,
 * and the app taking over does not replace it with a different one.
 *
 * It still only appears if the host takes longer than a moment. A fast start
 * goes straight to the app, so the common case never sees a splash that
 * flashes and disappears.
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

/**
 * The opening screen, for the window that has one before the app does.
 *
 * `ground` is what the app last told us it was painting with; without it the
 * page falls back to the default presets and follows the desktop's light/dark
 * setting, which is what the app does on a first launch too.
 */
export function startingPageHtml(ground: StartupGround | undefined, systemDark: boolean): string {
  return startupScreenPageHtml({
    title: PRODUCT_DISPLAY_NAME,
    // The same slot the app fills with "Connecting to your workspace": one
    // line, no full stop, about the person's work rather than our processes.
    label: "Starting your workspace",
    tokens: activeGround(ground, systemDark),
    pair: groundPair(ground),
  });
}

export function startingPageUrl(ground: StartupGround | undefined, systemDark: boolean): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(startingPageHtml(ground, systemDark))}`;
}

export interface StatusPageContent {
  /** One line, sentence case, no full stop. */
  title: string;
  /** What is happening and what to do about it. Already written for a person. */
  message: string;
  /** Absolute path to the host log, shown small and selectable. */
  logFile: string;
}

export function statusPageUrl(content: StatusPageContent): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml(content))}`;
}

export function statusPageHtml({ title, message, logFile }: StatusPageContent): string {
  // DESIGN.md tokens, both themes, no web fonts: this page renders before
  // anything has been downloaded, so it uses the platform's own UI stack.
  const action = `<button id="retry" type="button">Try again</button>`;
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
