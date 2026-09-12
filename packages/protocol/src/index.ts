/**
 * @lasercode/protocol
 *
 * The only vocabulary that crosses package boundaries. ACP-shaped JSON-RPC
 * with `pi/*` namespaced extras. This package MUST NOT import anything from
 * `@earendil-works/*` or `pi-subagents` (enforced by the seam test, M0-T5).
 */
export * from "./identity.js";
export * from "./features.js";
export * from "./agents.js";
export * from "./web-search.js";
export * from "./provider-failure.js";
export * from "./fallback.js";
export * from "./mcp.js";
export * from "./jsonrpc.js";
export * from "./messages.js";
export * from "./environment.js";
export * from "./project-env.js";
export * from "./attention.js";
export * from "./tasks.js";
export * from "./pending.js";
export * from "./pi-extension.js";
export * from "./push.js";
export * from "./schemas.js";
export * from "./utf8.js";
export * from "./search-content.js";
export * from "./goal-presentation.js";
export * from "./history-window.js";
export * from "./instruction-templates.js";
