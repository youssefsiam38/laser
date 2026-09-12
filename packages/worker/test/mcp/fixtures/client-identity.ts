import type { McpServerConfig } from "@lasercode/protocol";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureHttpServer } from "./http-server.js";

export const IDENTITY_TRANSPORTS = ["stdio", "streamable-http", "sse"] as const;
export type IdentityTransport = typeof IDENTITY_TRANSPORTS[number];

/** Fixture-owned observations, never the identity the client intended to send. */
export async function identityFixture(transport: IdentityTransport, base: string) {
  const http = transport === "stdio" ? undefined : await startFixtureHttpServer(transport);
  const log = join(base, "client-info.jsonl");
  return {
    config(name: string): McpServerConfig {
      return {
        name,
        transport: http
          ? { kind: "http", url: http.url, stream: transport as "streamable-http" | "sse" }
          : { kind: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./stdio-server.mjs", import.meta.url)), "--client-info", log] },
        startup: "at-start",
        tools: { exposure: "direct" },
        // Force initialize even if a newer SDK begins preferring server/discover.
        protocolVersion: "legacy",
      };
    },
    received(): unknown[] {
      return http?.clientInfos ?? (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
    },
    close: async () => { await http?.close(); },
  };
}
