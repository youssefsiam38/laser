#!/usr/bin/env node
/** Offline packaging fixture, following worker/test/mcp/fixtures/stdio-server.mjs.
 * No SDK or network: the real adapter must discover and call this stdio tool.
 */
import { createInterface } from "node:readline";

const tool = {
  name: "runtime",
  description: "Report the runtime executing this packaged fixture.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

function handle({ method, params }) {
  switch (method) {
    case "initialize":
      return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "packaged-fixture", version: "1.0.0" } };
    case "ping": return {};
    case "tools/list": return { tools: [tool] };
    case "tools/call":
      if (params.name === tool.name) return { content: [{ type: "text", text: process.execPath }] };
      throw new Error("Unknown fixture tool");
    default: throw new Error("Unknown fixture method");
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let response;
  try {
    response = { result: handle(request) };
  } catch (error) {
    response = { error: { code: -32601, message: error.message } };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response })}\n`);
});
process.stdin.on("end", () => process.exit(0));
