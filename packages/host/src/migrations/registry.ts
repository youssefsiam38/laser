import type { MigrationRegistry } from "./types.js";

/**
 * Declared by the staged runtime generation. Production currently has no data
 * rewrite; framework tests inject a synthetic next-schema registry.
 */
export const MIGRATION_REGISTRY: MigrationRegistry = {
  targetSchema: 1,
  steps: [],
};
