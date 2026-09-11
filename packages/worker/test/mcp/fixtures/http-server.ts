/**
 * The same fixture server over Streamable HTTP: one POST per JSON-RPC
 * message, answered with a JSON body. No SSE, no session resumption — enough
 * for the transport negotiation the engine performs and for a real tool call.
 */
import { createServer, type Server } from "node:http";
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

export function startFixtureHttpServer(): Promise<FixtureHttpServer> {
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST") {
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
        try {
          const value = answer(message.method ?? "", message.params);
          replies.push(value === undefined
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } }
            : { jsonrpc: "2.0", id: message.id, result: value });
        } catch (error) {
          replies.push({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: (error as Error).message } });
        }
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
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
