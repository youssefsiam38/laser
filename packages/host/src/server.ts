/**
 * HostServer (M1-T1) — HTTP + WebSocket on 127.0.0.1.
 *   GET /           → the UI bundle (SPA fallback), or a placeholder if not built
 *   GET /healthz    → ok
 *   WS  /ws         → JSON-RPC: client requests in, responses + worker notifications out
 *
 * Every connected client receives every worker notification for now; per-session
 * subscriptions arrive with M2-T3. Binding is loopback only; remote access goes
 * through the relay (M6), never by opening this port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { JsonRpcNotification } from "@piorbit/protocol";
import { SessionCatalog, defaultSessionDir } from "./catalog.js";
import { Router } from "./router.js";
import { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";

export interface HostServerOptions {
  host?: string;
  port?: number;
  agentDir?: string;
  sessionDir?: string;
  subagentsTempRoot?: string;
  workerMain?: string;
  nodeBinary?: string;
  /** Directory of the built UI; defaults to the workspace `@piorbit/ui/dist` if present. */
  uiDir?: string;
  log?: (line: string) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export function defaultUiDir(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve("@piorbit/ui/package.json");
    const dir = join(pkg, "..", "dist");
    return existsSync(join(dir, "index.html")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

export class HostServer {
  readonly pool: WorkerPool;
  readonly catalog: SessionCatalog;
  readonly router: Router;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly log: (line: string) => void;
  private readonly uiDir: string | undefined;

  constructor(private readonly options: HostServerOptions = {}) {
    this.log = options.log ?? (() => {});
    this.uiDir = options.uiDir ?? defaultUiDir();
    this.catalog = new SessionCatalog(options.sessionDir ?? defaultSessionDir(options.agentDir));

    const poolOptions: WorkerPoolOptions = {
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      ...(options.subagentsTempRoot ? { subagentsTempRoot: options.subagentsTempRoot } : {}),
      ...(options.workerMain ? { workerMain: options.workerMain } : {}),
      ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
      onNotification: (_cwd, n) => this.broadcast(n),
      onStderr: (cwd, text) => this.log(`[worker ${cwd}] ${text.trimEnd()}`),
    };
    this.pool = new WorkerPool(poolOptions);
    this.router = new Router(this.pool, this.catalog);

    this.http = createServer((req, res) => this.serveHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port ?? 0, host, () => resolve());
    });
    const { port } = this.http.address() as AddressInfo;
    const url = `http://${host}:${port}`;
    this.log(`piorbit host listening on ${url}`);
    return { host, port, url };
  }

  async close(): Promise<void> {
    for (const ws of this.clients) ws.close(1001, "host shutting down");
    this.clients.clear();
    await this.pool.stopAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private broadcast(notification: JsonRpcNotification): void {
    const line = JSON.stringify(notification);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(line);
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("message", async (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "invalid JSON" } }));
        return;
      }
      const response = await this.router.handle(raw);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private serveHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (!this.uiDir) {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<!doctype html><title>piorbit</title><p>piorbit host is running. Build <code>@piorbit/ui</code> to serve the app.</p>");
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(this.uiDir, rel);
    if (!file.startsWith(this.uiDir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(this.uiDir, "index.html"); // SPA fallback
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }
}
