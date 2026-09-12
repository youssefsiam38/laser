/**
 * The same fixture server over Streamable HTTP or legacy SSE, with received
 * initialize identities retained for real transport regression tests.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOOLS = [
  {
    name: "echo",
    description: "Return the text it was given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  { name: "snapshot", description: "Return a picture and a line of text.", inputSchema: { type: "object", properties: {} } },
];

export interface FixtureHttpServer {
  url: string;
  clientInfos: unknown[];
  close(): Promise<void>;
}

function answer(method: string, params: Record<string, unknown> | undefined): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: typeof params?.["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18",
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: "fixture-http", version: "0.1.0" },
        instructions: "An HTTP fixture.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    case "tools/call": {
      const name = (params as { name?: string } | undefined)?.name;
      const args = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}) as { text?: string };
      if (name === "echo") return { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] };
      if (name === "snapshot") return { content: [{ type: "text", text: "a picture" }, { type: "image", data: PNG, mimeType: "image/png" }] };
      throw new Error(`unknown tool: ${String(name)}`);
    }
    default:
      return undefined;
  }
}

export function startFixtureHttpServer(mode: "streamable-http" | "sse" = "streamable-http"): Promise<FixtureHttpServer> {
  const clientInfos: unknown[] = [];
  const streams = new Map<string, ServerResponse>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (mode === "sse" && request.method === "GET" && url.pathname === "/mcp") {
      const session = randomUUID();
      streams.set(session, response);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`event: endpoint\ndata: /messages?session=${session}\n\n`);
      response.on("close", () => streams.delete(session));
      return;
    }
    if (request.method !== "POST" || (mode === "sse" && url.pathname !== "/messages")) {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        response.writeHead(400).end();
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const replies: unknown[] = [];
      for (const message of messages as Array<{ id?: unknown; method?: string; params?: Record<string, unknown> }>) {
        if (message.id === undefined) continue;
        if (message.method === "initialize") clientInfos.push(message.params?.["clientInfo"]);
        try {
          const value = answer(message.method ?? "", message.params);
          replies.push(value === undefined
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } }
            : { jsonrpc: "2.0", id: message.id, result: value });
        } catch (error) {
          replies.push({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: (error as Error).message } });
        }
      }
      if (mode === "sse") {
        const stream = streams.get(url.searchParams.get("session") ?? "");
        if (!stream) { response.writeHead(404).end(); return; }
        for (const reply of replies) stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        response.writeHead(202).end();
        return;
      }
      if (replies.length === 0) {
        response.writeHead(202, { "mcp-session-id": "fixture" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture" });
      response.end(JSON.stringify(replies.length === 1 ? replies[0] : replies));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        clientInfos,
        close: () => new Promise<void>((done) => {
          for (const stream of streams.values()) stream.end();
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
