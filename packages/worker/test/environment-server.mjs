// Dependency-free stdio MCP fixture: reports booleans, never environment values.
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  switch (method) {
    case "initialize":
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "environment-fixture", version: "1.0.0" } };
      break;
    case "tools/list":
      result = { tools: [{ name: "presence", description: "Report synthetic export presence only", inputSchema: { type: "object", properties: {} } }] };
      break;
    case "tools/call": {
      const present = Object.hasOwn(process.env, "SYNTHETIC_SHELL_EXPORT");
      const overridden = process.env.SYNTHETIC_SHELL_EXPORT === "explicit-fixture";
      // A real non-interactive shell sees the same export; no profile sourcing.
      const shell = process.platform === "win32" ? undefined : spawnSync("/bin/bash", ["-c", "test -n \"$SYNTHETIC_SHELL_EXPORT\""], { stdio: "ignore" });
      result = { content: [{ type: "text", text: JSON.stringify({ present, overridden, shellPresent: shell?.status === 0 }) }] };
      break;
    }
    default: result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
});
process.stdin.on("end", () => process.exit(0));
