/**
 * MCP servers: the engine's status, in the person's words (docs/mcp.md).
 *
 * The MCP engine publishes a versioned, read-only snapshot on the session's
 * event bus. This module is the only thing that listens to it, maps its
 * internal states onto Laser's vocabulary and sends the result to the worker,
 * which answers `mcp/list` from it. It never connects anything, never reads a
 * file, and never names the engine: the worker passes the channel in, so this
 * package takes no dependency on the adapter.
 */
import type { McpRuntimeServer, McpRuntimeSnapshot, McpServerStatus } from "@lasercode/protocol";
import type { LaserModule, ModuleContext } from "./index.js";

/** What the worker hands over when the engine is loaded for this session. */
export interface McpModuleOptions {
  /** The event-bus channel the engine publishes its snapshots on. */
  statusEvent: string;
}

/**
 * The engine's internal states, in the words docs/mcp.md settled on. `cached`
 * means the tools are known and usable without a live connection, which is
 * what `ready` says; `not-connected` says nothing about whether it works.
 */
const STATUS: Record<string, McpServerStatus> = {
  connected: "connected",
  cached: "ready",
  "not-connected": "unknown",
  failed: "failed",
  "needs-auth": "needs-auth",
  disabled: "off",
};

interface EngineServer {
  name?: unknown;
  status?: unknown;
  toolCount?: unknown;
  directToolCount?: unknown;
  resourceCount?: unknown;
  failedAgoSeconds?: unknown;
}

/** One engine snapshot in Laser's vocabulary, or undefined if it is not one. */
export function toRuntimeSnapshot(raw: unknown): McpRuntimeSnapshot | undefined {
  const snapshot = raw as { servers?: unknown; totalTools?: unknown; connectedCount?: unknown } | null;
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.servers)) return undefined;
  const servers: McpRuntimeServer[] = [];
  for (const entry of snapshot.servers as EngineServer[]) {
    const name = typeof entry?.name === "string" ? entry.name : undefined;
    const status = typeof entry?.status === "string" ? STATUS[entry.status] : undefined;
    if (!name) continue;
    servers.push({
      name,
      status: status ?? "unknown",
      toolCount: count(entry.toolCount),
      directToolCount: count(entry.directToolCount),
      ...(entry.resourceCount !== undefined ? { resourceCount: count(entry.resourceCount) } : {}),
      ...(entry.failedAgoSeconds !== undefined ? { failedAgoSeconds: count(entry.failedAgoSeconds) } : {}),
    });
  }
  return {
    servers,
    totalTools: typeof snapshot.totalTools === "number" ? snapshot.totalTools : servers.reduce((sum, server) => sum + server.toolCount, 0),
    connectedCount: typeof snapshot.connectedCount === "number"
      ? snapshot.connectedCount
      : servers.filter((server) => server.status === "connected").length,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export const mcpModule: LaserModule = {
  name: "mcp",
  // The worker decides: the engine is loaded only for a project that has at
  // least one enabled server, and it passes the channel when it does.
  detect: (ctx: ModuleContext) => !!ctx.mcp?.statusEvent,
  activate(ctx: ModuleContext) {
    const channel = ctx.mcp?.statusEvent;
    if (!channel) return;
    const unsubscribe = ctx.pi.events.on(channel, (data: unknown) => {
      const snapshot = toRuntimeSnapshot(data);
      if (snapshot) ctx.send({ type: "lasercode/mcp/status", snapshot });
    });
    return () => unsubscribe();
  },
};
