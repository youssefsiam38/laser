import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the UI runs on 5173 and talks to a host on 41441; in production the
// host serves the built bundle and the client uses the page's own origin.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/ws": { target: "ws://127.0.0.1:41441", ws: true } },
  },
});
