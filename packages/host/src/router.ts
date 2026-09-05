/**
 * Router — turns a client's JSON-RPC request into a worker call.
 *
 * Routing rules:
 *   session/new         → worker for params.cwd
 *   session/load        → worker for the cwd that owns the path (pool memory,
 *                         else the session file header via the catalog)
 *   everything with a path → same lookup
 *   pi/session/list     → answered here from the catalog
 *   pi/ui/response      → broadcast to every worker (dialog ids are unique)
 */
import {
  ErrorCodes,
  ProtocolError,
  parseClientRequest,
  type JsonRpcError,
  type JsonRpcResponse,
  type SessionState,
  type TypedClientRequest,
} from "@piorbit/protocol";
import type { SessionCatalog } from "./catalog.js";
import type { WorkerPool } from "./worker-pool.js";
import { WorkerRpcError } from "./worker-client.js";

export class Router {
  constructor(
    private readonly pool: WorkerPool,
    private readonly catalog: SessionCatalog,
  ) {}

  async handle(raw: unknown): Promise<JsonRpcResponse> {
    const id = (raw as { id?: string | number } | null)?.id ?? 0;
    try {
      const req = parseClientRequest(raw);
      const result = await this.dispatch(req);
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
  }

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    switch (req.method) {
      case "pi/session/list":
        return { sessions: this.catalog.list(req.params.cwd).map(({ size: _size, ...s }) => s) };

      case "session/new": {
        const worker = await this.pool.get(req.params.cwd);
        const result = await worker.request<{ state: SessionState }>(req.method, req.params);
        this.pool.bindSession(result.state.path, req.params.cwd);
        return result;
      }

      case "pi/ui/response": {
        await Promise.all(
          this.pool.cwds().map(async (cwd) => {
            const w = await this.pool.get(cwd);
            await w.request(req.method, req.params).catch(() => {});
          }),
        );
        return {};
      }

      default: {
        const path = (req.params as { path: string }).path;
        const cwd = this.pool.cwdOfSession(path) ?? this.catalog.cwdOf(path);
        if (!cwd) throw new ProtocolError(ErrorCodes.SessionNotFound, `no project known for session ${path}`);
        const worker = await this.pool.get(cwd);
        const result = await worker.request(req.method, req.params);
        if (req.method === "session/load") this.pool.bindSession(path, cwd);
        return result;
      }
    }
  }
}

function toRpcError(error: unknown): JsonRpcError {
  if (error instanceof ProtocolError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
  }
  if (error instanceof WorkerRpcError) return error.rpc;
  return { code: ErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) };
}
