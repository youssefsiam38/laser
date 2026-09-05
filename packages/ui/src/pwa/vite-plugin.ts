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
import { DECLARATIVE_WEB_PUSH_VERSION } from "@piorbit/protocol";

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

const DEV_SW = `// piorbit dev: no app-shell caching on the dev server. A stale production worker
// on this origin would serve old bundles, so this one removes itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("piorbit-shell-")) await caches.delete(name);
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
`;

export interface PiorbitPwaOptions {
  /** Module the plugin injects into the HTML head. Default `/src/pwa/boot.ts`. */
  bootModule?: string;
}

export function piorbitPwa(options: PiorbitPwaOptions = {}): Plugin {
  const bootModule = options.bootModule ?? "/src/pwa/boot.ts";
  return {
    name: "piorbit:pwa",

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
        res.end(DEV_SW);
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
        throw new Error("piorbit:pwa — sw.ts must not import anything at runtime; /sw.js is emitted as one file");
      }
      // The worker restates the push document's shape because it cannot import
      // it. The version tag is the one part that could drift without anything
      // failing, so it is checked against the protocol here.
      if (!worker.includes(`DECLARATIVE_WEB_PUSH_VERSION = ${DECLARATIVE_WEB_PUSH_VERSION}`)) {
        throw new Error(
          `piorbit:pwa — sw.ts declares a different DECLARATIVE_WEB_PUSH_VERSION than @piorbit/protocol (${DECLARATIVE_WEB_PUSH_VERSION})`,
        );
      }

      const build = createHash("sha256").update(precache.join("\n")).update(worker).digest("hex").slice(0, 12);
      const out = worker.replace('"__PIORBIT_PRECACHE__"', JSON.stringify(precache)).replace("__PIORBIT_BUILD__", build);
      if (!out.includes(JSON.stringify(precache))) throw new Error("piorbit:pwa — the precache placeholder was not found in sw.ts");
      this.emitFile({ type: "asset", fileName: "sw.js", source: out });
    },
  };
}

