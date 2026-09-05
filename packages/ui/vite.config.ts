import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { piorbitPwa, productIdentityHtml } from "./src/pwa/vite-plugin.js";

// In dev the UI runs on 5173 and talks to a host on 41441; in production the
// host serves the built bundle and the client uses the page's own origin.
export default defineConfig({
  // piorbitPwa emits /sw.js (app shell only) and injects src/pwa/boot.ts (M7-T1).
  plugins: [react(), tailwindcss(), productIdentityHtml(), piorbitPwa()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom", "@assistant-ui/react"],
  },
  optimizeDeps: { include: ["remark-gfm"] },
  // The host (and, per the architecture, the relay) serves dist verbatim, so a
  // sourcemap comment would publish the whole unminified source.
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/ws": { target: "ws://127.0.0.1:41441", ws: true } },
  },
});
