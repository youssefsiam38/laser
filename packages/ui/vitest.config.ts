import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // The transcript's list mounts rows only once its scroller has a box, and
    // a headless DOM lays nothing out. This gives that one element a size;
    // see the file for why it is the only thing it touches.
    setupFiles: ["./test/list-layout.ts"],
    passWithNoTests: true,
  },
});
