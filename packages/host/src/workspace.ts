/**
 * Node-backed workspace IO for the host. Implementation lives in
 * `@lasercode/protocol/workspace-node` so the host and worker share one runner.
 */
export { createWorkspaceResolver, nodeWorkspaceIO } from "@lasercode/protocol/workspace-node";
