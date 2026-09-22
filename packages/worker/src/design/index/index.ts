/**
 * The Design Index (M21-T10, `docs/design-phase.md`).
 *
 * Parse-only by construction: no module in this directory imports
 * `node:child_process`, `node:net`, `node:http`, `node:https` or a fetch
 * client, and none of them evaluates a project file. `test/design/parse-only.test.ts`
 * walks this module graph and proves it.
 */
export * from "./facts.js";
export * from "./scan.js";
export * from "./l0-stack.js";
export * from "./l0-styles.js";
export * from "./l0-tokens.js";
export * from "./l0-components.js";
export * from "./l0-templates.js";
export * from "./l0-assets.js";
export * from "./tokens.js";
export * from "./eras.js";
export * from "./build.js";
export * from "./l1-synthesis.js";
export * from "./review.js";
export * from "./storage.js";
export * from "./command.js";
export * from "./tools.js";
export * from "./bridge.js";
