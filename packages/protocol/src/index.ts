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
export * from "./runtime-recovery.js";
export * from "./runtime-activation.js";
export * from "./runtime-activation-copy.js";
export * from "./fallback.js";
export * from "./mcp.js";
export * from "./jsonrpc.js";
export * from "./git-actions.js";
export * from "./messages.js";
export * from "./source-control.js";
export * from "./project-work.js";
export * from "./project-work-bodies.js";
export * from "./project-work-methods.js";
export * from "./project-work-mentions.js";
export * from "./design-tree.js";
export * from "./research.js";
export * from "./environment.js";
export * from "./method-policy.js";
export * from "./environment-policy.js";
export * from "./project-env.js";
export * from "./workspace.js";
// Node git runner lives behind `./workspace-node`, so the UI bundle never
// reaches `node:child_process` through this barrel.
export * from "./attention.js";
export * from "./tasks.js";
export * from "./pending.js";
export * from "./resources.js";
export * from "./session-lifetime.js";
export * from "./memory-pressure.js";
export * from "./heap-ceiling.js";
export * from "./pi-extension.js";
export * from "./provider-capture.js";
export * from "./transport-pressure.js";
export * from "./log-redaction.js";
export * from "./credential-scan.js";
export * from "./push.js";
export * from "./schemas.js";
export * from "./utf8.js";
export * from "./search-content.js";
export * from "./tool-label.js";
export * from "./tool-contract.js";
export * from "./human-label.js";
export * from "./goal-presentation.js";
export * from "./history-window.js";
export * from "./telemetry.js";
export * from "./body-range.js";
export * from "./reasoning-segments.js";
// Pure and browser-safe. The Node hash lives behind `./revision-node`, so the
// UI bundle never reaches `node:crypto` through this barrel.
export * from "./session-revision.js";
export * from "./instruction-templates.js";
