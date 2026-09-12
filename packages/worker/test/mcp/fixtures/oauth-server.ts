/**
 * An MCP server over HTTP that demands OAuth, entirely offline: protected
 * resource metadata, authorization-server metadata, dynamic client
 * registration, an authorization endpoint that hands back a code, and a token
 * endpoint. Its `/mcp` endpoint answers MCP only with a valid bearer token and
 * returns `401` with a `WWW-Authenticate` challenge otherwise — which is what
 * makes the engine's sign-in path run for real, without a network or a browser.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const ACCESS_TOKEN = "fixture-access-token";

export interface FixtureOAuthServer {
  url: string;
  /** Codes the authorization endpoint has issued, newest last. */
  issuedCodes: string[];
  /** How many times a token was minted, so a refresh is visible. */
  tokenGrants: number;
  clientInfos: unknown[];
  registrations: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

function mcpAnswer(method: string, params: Record<string, unknown> | undefined): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: typeof params?.["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture-oauth", version: "0.1.0" },
        instructions: "A server that wants you signed in.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [{ name: "whoami", description: "Say who is signed in.", inputSchema: { type: "object", properties: {} } }] };
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    case "tools/call":
      return { content: [{ type: "text", text: "signed in" }] };
    default:
      return undefined;
  }
}

export function startFixtureOAuthServer(): Promise<FixtureOAuthServer> {
  const issuedCodes: string[] = [];
  const clientInfos: unknown[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  let tokenGrants = 0;
  let base = "";

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base || "http://127.0.0.1");
    const path = url.pathname;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };

    // Discovery. The SDK tries the well-known names with and without the
    // resource path suffix, so match on the name rather than the whole path.
    if (path.includes("/.well-known/oauth-protected-resource")) {
      json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["mcp"] });
      return;
    }
    if (path.includes("/.well-known/oauth-authorization-server") || path.includes("/.well-known/openid-configuration")) {
      json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
      return;
    }
    if (path === "/register" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const parsed = (() => {
          try {
            return JSON.parse(body) as { redirect_uris?: string[] };
          } catch {
            return {};
          }
        })();
        registrations.push(parsed);
        json(201, {
          client_id: "fixture-client",
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: parsed.redirect_uris ?? [],
          token_endpoint_auth_method: "none",
        });
      });
      return;
    }
    if (path === "/authorize") {
      // Nothing opens a browser here; the test takes the code from the URL.
      const code = `code-${issuedCodes.length + 1}`;
      issuedCodes.push(code);
      json(200, { code });
      return;
    }
    if (path === "/token" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        tokenGrants += 1;
        json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "fixture-refresh", scope: "mcp" });
      });
      return;
    }

    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
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
      for (const message of messages as Array<{ method?: string; params?: Record<string, unknown> }>) {
        if (message.method === "initialize") clientInfos.push(message.params?.["clientInfo"]);
      }
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        json(401, { error: "unauthorized" }, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        return;
      }
      const replies: unknown[] = [];
      for (const message of messages as Array<{ id?: unknown; method?: string; params?: Record<string, unknown> }>) {
        if (message.id === undefined) continue;
        const value = mcpAnswer(message.method ?? "", message.params);
        replies.push(value === undefined
          ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } }
          : { jsonrpc: "2.0", id: message.id, result: value });
      }
      if (replies.length === 0) {
        response.writeHead(202, { "mcp-session-id": "fixture" }).end();
        return;
      }
      json(200, replies.length === 1 ? replies[0] : replies, { "mcp-session-id": "fixture" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      resolve({
        url: `${base}/mcp`,
        clientInfos,
        registrations,
        get issuedCodes() {
          return issuedCodes;
        },
        get tokenGrants() {
          return tokenGrants;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
