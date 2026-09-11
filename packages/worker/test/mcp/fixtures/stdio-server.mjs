#!/usr/bin/env node
/**
 * A minimal MCP server over stdio, for tests: no network, no dependencies,
 * deterministic. Speaks JSON-RPC over newline-delimited stdin/stdout and
 * implements exactly what the inspector and the engine ask for.
 *
 * Arguments:
 *   --name <n>     the server name reported in `initialize` (default fixture)
 *   --fail-tools   answer `tools/list` with an error, to exercise a failure
 *   --stderr <s>   write a line to stderr at start (for the stderr tail)
 */
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const serverName = option("--name", "fixture");
const failTools = args.includes("--fail-tools");
const stderrLine = option("--stderr", undefined);
if (stderrLine) process.stderr.write(`${stderrLine}\n`);
if (args.includes("--exit-early")) process.exit(3);

/** One tiny transparent PNG, so an image content block is a real image. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Return the text it was given.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "What to say back" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "snapshot",
    description: "Return a picture and a line of text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "explode",
    description: "Always fails, so a failing call can be tested.",
    inputSchema: { type: "object", properties: {} },
  },
];

const RESOURCES = [{ uri: "fixture://notes", name: "notes", description: "A note", mimeType: "text/plain" }];
const TEMPLATES = [{ uriTemplate: "fixture://notes/{id}", name: "note", description: "One note by id" }];
const PROMPTS = [{ name: "greet", description: "Say hello", arguments: [{ name: "who", description: "Who to greet", required: true }] }];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

export function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {}, logging: {} },
        serverInfo: { name: serverName, version: "1.2.3", title: "Fixture server" },
        instructions: "Call echo to hear yourself think.",
      };
    case "ping":
      if (args.includes("--fail-ping")) throw new Error("the fixture refused the ping");
      return {};
    case "tools/list":
      if (failTools) throw new Error("tools are unavailable in this fixture");
      return { tools: TOOLS };
    case "resources/list":
      return { resources: RESOURCES };
    case "resources/templates/list":
      return { resourceTemplates: TEMPLATES };
    case "prompts/list":
      return { prompts: PROMPTS };
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") return { content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] };
      if (name === "snapshot") {
        return { content: [{ type: "text", text: "a picture" }, { type: "image", data: PNG, mimeType: "image/png" }] };
      }
      if (name === "explode") return { content: [{ type: "text", text: "the fixture refused" }], isError: true };
      throw new Error(`unknown tool: ${String(name)}`);
    }
    default:
      return undefined;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const requests = Array.isArray(request) ? request : [request];
  for (const one of requests) {
    if (one.id === undefined) continue; // a notification
    try {
      const value = handle(one);
      if (value === undefined) {
        send({ jsonrpc: "2.0", id: one.id, error: { code: -32601, message: `unknown method: ${one.method}` } });
        continue;
      }
      result(one.id, value);
    } catch (error) {
      send({ jsonrpc: "2.0", id: one.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
