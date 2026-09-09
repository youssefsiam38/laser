/**
 * Vite plugin for the PWA pieces the bundle cannot know about itself.
 *
 *   build   compiles `sw.ts` with Vite's esbuild, fills in the precache list
 *           from the emitted bundle plus the shell files in `public/`, and
 *           emits it as `/sw.js`; injects the `boot.ts` module into the HTML
 *           so registration happens without touching `main.tsx`.
 *   dev     serves a `/sw.js` that unregisters itself, so a production worker
 *           left on the same origin cannot hijack the dev server; `boot.ts`
 *           still runs (install prompt, viewport guards) but skips registration.
 *
 * No workbox, no runtime dependency: the worker is ~200 lines and the only
 * generated part is a list of file names.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild, type Plugin } from "vite";
import { DECLARATIVE_WEB_PUSH_VERSION, FORMER_NAMES, PRODUCT_DISPLAY_NAME, PRODUCT_NAME, STORAGE_PREFIX, dottedStorageKey, storageKey, SW_SKIP_WAITING, SW_PUSH_CHANGED } from "@lasercode/protocol";
import { STARTUP_SCREEN_ROOT_CLASS, renderStartupNodes, startupScene } from "@lasercode/protocol/startup-screen";

import { compileVars } from "../theme/compile.js";
import { DEFAULT_LIGHT_PRESET_ID, DEFAULT_PRESET, getPreset } from "../theme/presets.js";
import type { Theme, ThemePreset } from "../theme/types.js";

/** A preset is a theme plus the one line the gallery shows beside it. */
const asTheme = (preset: ThemePreset): Theme => {
  const { tagline: _tagline, ...theme } = preset;
  return theme;
};

/** Shell files copied from `public/`; they never appear in the Rollup bundle. */
const PUBLIC_SHELL = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-96.png",
  // The typefaces the shell is drawn in. Without these the offline page and a
  // cold start render in the fallback stack, which is a different app.
  "/fonts/host-grotesk-latin.woff2",
  "/fonts/host-grotesk-latin-ext.woff2",
  "/fonts/martian-mono-latin.woff2",
  "/fonts/martian-mono-latin-ext.woff2",
];

/**
 * The offline page's colours and typeface, compiled from the shipped presets
 * at build time rather than restated as hex literals. It cannot reach the
 * app's stylesheet — it is what renders when the app did not load — so the
 * handful of values it needs are inlined here, from the same compiler every
 * other surface uses.
 */
function offlineStyle(): string {
  const dark = compileVars(asTheme(DEFAULT_PRESET));
  const light = compileVars(asTheme(getPreset(DEFAULT_LIGHT_PRESET_ID) ?? DEFAULT_PRESET));
  const pick = (vars: Record<string, string>, name: string): string => vars[name] ?? "";
  return [
    ":root{color-scheme:light dark}",
    `body{margin:0;min-height:100dvh;display:grid;place-items:center;font:14px/1.5 ${pick(light, "--font-sans")};`,
    `background:${pick(light, "--bg")};color:${pick(light, "--ink")};`,
    "padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom))}",
    `@media(prefers-color-scheme:dark){body{background:${pick(dark, "--bg")};color:${pick(dark, "--ink")}}}`,
    "main{max-width:36ch}h1{font-size:22px;line-height:28px;margin:0 0 8px}",
    `p{margin:0;color:${pick(light, "--ink-2")}}`,
    `@media(prefers-color-scheme:dark){p{color:${pick(dark, "--ink-2")}}}`,
  ].join("");
}

/** The service worker's cache namespace, and this plugin's own name in errors. */
const CACHE_PREFIX = `${STORAGE_PREFIX}-shell-`;
const PLUGIN = `${PRODUCT_NAME}:pwa`;

const devWorker = (cachePrefix: string): string => `// dev: no app-shell caching on the dev server. A stale production worker
// on this origin would serve old bundles, so this one removes itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("${cachePrefix}")) await caches.delete(name);
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
`;

export interface LaserPwaOptions {
  /** Module the plugin injects into the HTML head. Default `/src/pwa/boot.ts`. */
  bootModule?: string;
}

/**
 * The product's identity, substituted into index.html at build time (MX-T7).
 *
 * `index.html` is the one file the app ships that cannot import anything: its
 * boot script runs before any module, and it has to know the theme storage key
 * to replay a stored theme before first paint. So the three names it needs are
 * placeholders, filled from product.json here, and a rename reaches the title,
 * the iOS home-screen name and the storage key with no second edit.
 */
/**
 * The opening screen, in the shell HTML (M13-T32).
 *
 * The bundle takes a moment to parse and run, and until it does there is
 * nothing in `#root`. That moment used to be bare ground between the shell's
 * screen and the app's — the "two screens" a person actually sees. So the same
 * scene the React screen renders, and that the desktop shell draws before this
 * page exists, is also the document's own first frame; React replaces it with
 * the identical thing and, on that first mount, without an arrival animation.
 *
 * The stylesheet is a render-blocking `<link>` in a built app, so this is
 * styled from the first paint. In a dev run the styles arrive with the module
 * graph, so it is briefly unstyled — a development-only cost.
 */
function startupScreenMarkup(): string {
  const scene = renderStartupNodes(
    startupScene({
      idPrefix: "boot",
      title: PRODUCT_DISPLAY_NAME,
      // The same words the app's own screen opens with, so the first thing
      // React does is not change the sentence.
      label: "Connecting to your workspace",
    }),
  );
  return `<div class="${STARTUP_SCREEN_ROOT_CLASS}" data-continuing role="status" aria-live="polite" aria-busy="true" aria-label="Connecting to your workspace">${scene}</div>`;
}

export function productIdentityHtml(): Plugin {
  const values: Record<string, string> = {
    PRODUCT_DISPLAY_NAME,
    THEME_STYLE_ID: storageKey("theme"),
    // Current key first, then every former name's. `migrateFormerBrowserStorage`
    // moves them, but it runs from a module and the boot script runs before any
    // module loads — so without this the first frame after a rename is the
    // default theme, on the one launch a person is most likely to be watching.
    THEME_STORAGE_KEYS: JSON.stringify([
      dottedStorageKey("theme"),
      ...FORMER_NAMES.map((former) => `${former.storagePrefix}.theme`),
    ]),
    // The ground the very first frame is painted with, before the bundle's
    // stylesheet exists and before the boot script has anything stored to
    // replay. Compiled from the default preset rather than written down, so a
    // change to the palette cannot leave a white flash behind (M13-T32).
    THEME_DEFAULT_BG: compileVars(asTheme(DEFAULT_PRESET))["--bg"] ?? "",
    STARTUP_SCREEN: startupScreenMarkup(),
  };
  return {
    name: `${PRODUCT_NAME}:identity`,
    transformIndexHtml(html) {
      return html.replace(/%([A-Z_]+)%/g, (match, key: string) => {
        const value = values[key];
        if (value === undefined) {
          throw new Error(
            `${PRODUCT_NAME}:identity — index.html asks for %${key}%, which product.json does not define. ` +
              `Add it to productIdentityHtml() in src/pwa/vite-plugin.ts, or fix the placeholder.`,
          );
        }
        return value;
      });
    },
  };
}

export function laserPwa(options: LaserPwaOptions = {}): Plugin {
  const bootModule = options.bootModule ?? "/src/pwa/boot.ts";
  return {
    name: PLUGIN,

    transformIndexHtml: {
      order: "pre",
      handler: () => [{ tag: "script", attrs: { type: "module", src: bootModule }, injectTo: "head" }],
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/sw.js") {
          next();
          return;
        }
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(devWorker(CACHE_PREFIX));
      });
    },

    async generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle)
        .filter((file) => /\.(m?js|css|woff2?)$/.test(file) && !file.endsWith(".map"))
        .map((file) => `/${file}`);
      const precache = ["/", "/index.html", ...PUBLIC_SHELL, ...emitted].filter((p, i, all) => all.indexOf(p) === i);

      const source = readFileSync(fileURLToPath(new URL("./sw.ts", import.meta.url)), "utf8");
      const { code } = await transformWithEsbuild(source, "sw.ts", {
        loader: "ts",
        target: "es2020",
        format: "esm",
        minify: false,
        sourcemap: false,
      });
      // `sw.ts` imports nothing at runtime, so the transformed source is the
      // whole worker. Its only `import` is `import type`, which esbuild drops.
      const worker = code;
      if (/^\s*import\s/m.test(worker)) {
        throw new Error(`${PLUGIN} — sw.ts must not import anything at runtime; /sw.js is emitted as one file`);
      }
      // The worker restates the push document's shape because it cannot import
      // it. The version tag is the one part that could drift without anything
      // failing, so it is checked against the protocol here.
      if (!worker.includes(`DECLARATIVE_WEB_PUSH_VERSION = ${DECLARATIVE_WEB_PUSH_VERSION}`)) {
        throw new Error(
          `${PLUGIN} — sw.ts declares a different DECLARATIVE_WEB_PUSH_VERSION than @lasercode/protocol (${DECLARATIVE_WEB_PUSH_VERSION})`,
        );
      }

      const build = createHash("sha256").update(precache.join("\n")).update(worker).digest("hex").slice(0, 12);
      const style = offlineStyle();
      const out = worker
        .replace('"__SW_PRECACHE__"', JSON.stringify(precache))
        .replace("__SW_BUILD__", build)
        .replace("__SW_CACHE_PREFIX__", CACHE_PREFIX)
        .replace("__SW_PRODUCT_NAME__", PRODUCT_DISPLAY_NAME)
        .replace("__SW_SKIP_WAITING__", SW_SKIP_WAITING)
        .replace("__SW_PUSH_CHANGED__", SW_PUSH_CHANGED)
        .replace("__SW_OFFLINE_STYLE__", () => style);
      if (!out.includes(JSON.stringify(precache))) throw new Error(`${PLUGIN} — the precache placeholder was not found in sw.ts`);
      if (out.includes("__SW_OFFLINE_STYLE__")) throw new Error(`${PLUGIN} — the offline-style placeholder was not found in sw.ts`);
      this.emitFile({ type: "asset", fileName: "sw.js", source: out });
    },
  };
}

