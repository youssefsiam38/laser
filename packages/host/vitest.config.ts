import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Runs before any test module: see the file for the incident it prevents.
    setupFiles: ["./test/engine-env.setup.ts"],
    passWithNoTests: true,
  },
});
