/**
 * A scripted OpenAI-compatible streaming provider for real-engine tests. Each
 * request is answered by `respond(body)`: plain text, or one tool call.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StubAnswer = { text: string } | { toolCall: { name: string; args: Record<string, unknown>; id?: string } };

export interface StubRequest {
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<{ type: string; function: { name: string } }>;
}

export interface StubProvider {
  server: Server;
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function startStubProvider(respond: (request: StubRequest, index: number) => StubAnswer): Promise<StubProvider> {
  const requests: StubRequest[] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body) as StubRequest;
      requests.push(request);
      const answer = respond(request, requests.length - 1);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `chatcmpl-${++calls}`, object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      if ("text" in answer) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
      } else {
        const id = answer.toolCall.id ?? `call_${calls}`;
        res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: answer.toolCall.name, arguments: "" } }] }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(answer.toolCall.args) } }] }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Point a sandboxed agent dir at the stub as provider `stub`, model `stub-1`. */
export function writeStubModels(agentDir: string, url: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: { baseUrl: url, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-1", name: "Stub One", contextWindow: 8000, maxTokens: 1000 }] },
      },
    }),
  );
}

/** The system text of a request, wherever the provider put it. */
export function systemTextOf(request: StubRequest): string {
  const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
  const content = system?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("");
  return "";
}

export function toolNamesOf(request: StubRequest): string[] {
  return (request.tools ?? []).map((tool) => tool.function.name);
}
