import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { laserPwa, productIdentityHtml } from "./src/pwa/vite-plugin.js";
import { bundleReport } from "./src/build/bundle-report.js";

// In dev the UI runs on 5173 and talks to a host on 41441; in production the
// host serves the built bundle and the client uses the page's own origin.
export default defineConfig({
  // laserPwa emits /sw.js (app shell only) and injects src/pwa/boot.ts (M7-T1).
  plugins: [react(), tailwindcss(), productIdentityHtml(), laserPwa(), bundleReport()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom", "@assistant-ui/react"],
  },
  optimizeDeps: { include: ["remark-gfm"] },
  // The host (and, per the architecture, the relay) serves dist verbatim, so a
  // sourcemap comment would publish the whole unminified source.
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      treeshake: {
        /**
         * `@lasercode/protocol` is one barrel, so importing any of it reaches
         * every module it re-exports, and Rollup keeps an unused module when it
         * cannot prove the module does nothing on import. Two of them do a lot:
         * the instruction-template vocabulary pulls a template engine and its
         * source-map dependency (275 KiB), and the wire schemas pull the schema
         * library (160 KiB) — neither of which a conversation runs.
         *
         * The package is a pure library: types, constants and functions, no
         * registration, no global state, nothing to run at import. Saying so
         * lets each of its modules follow the code that actually calls it —
         * into the agents editors, into the file explorer's chunk — instead of
         * riding the barrel into the first paint. Anything that genuinely must
         * run on import does not belong in the protocol package.
         */
        moduleSideEffects: (id) => !/[/\\]protocol[/\\]dist[/\\][^/\\]+\.js$/.test(id),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/ws": { target: "ws://127.0.0.1:41441", ws: true } },
  },
});
