import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    // Some of this package's promises are kept by the type system rather than
    // at runtime — a message that cannot be *built* never has to be refused —
    // so the `.test-d.ts` files are compiled as part of the ordinary run.
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
});
