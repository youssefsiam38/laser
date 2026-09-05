#!/usr/bin/env node
/**
 * Relay entry point (M6-T4). Configuration is environment-only, because that is
 * what Railway gives you and a config file on an ephemeral filesystem is a lie.
 *
 *   PORT                          listen port (Railway sets this)          8080
 *   RELAY_HOST                    bind address                          0.0.0.0
 *   RELAY_MAX_CHANNELS            channels held at once                   10000
 *   RELAY_MAX_FRAME_BYTES         largest forwarded binary frame          65536
 *   RELAY_ENFORCE_FRAME_SIZES     reject non-padded frame sizes               1
 *   RELAY_CHANNEL_CREATE_PER_MIN  new channels per IP per minute             30
 *   RELAY_CONNECT_PER_MIN         connection attempts per IP per minute     240
 *   RELAY_COOKIE_THRESHOLD        upgrades per 10 s before cookies          600
 *   RELAY_PING_INTERVAL_MS        app-level ping period                   20000
 *   RELAY_SOLO_TIMEOUT_MS         close a peerless socket after this          0
 *   RELAY_TRUST_PROXY             trusted proxy hops in front of us           0
 *
 * RELAY_TRUST_PROXY is a hop count, and it is 0 unless you set it. Behind
 * Railway (or any single reverse proxy) set it to 1; the relay then keys its
 * rate limits and cookie challenge on the last `x-forwarded-for` entry, which
 * the edge writes and a client cannot influence. Leaving it 0 on a directly
 * exposed relay is the safe default: the header is ignored entirely.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RelayServer } from "./server.js";

export { RelayServer, type RelayOptions, type RelayStats } from "./server.js";
export { CookieJar, COOKIE_ROTATION_MS } from "./cookie.js";
export { TokenBucket, LoadWindow } from "./limits.js";
export * from "./protocol.js";

export const RELAY_PING_INTERVAL_MS = 20_000;
export const RELAY_MAX_SOCKETS_PER_CHANNEL = 2;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name}=${raw} is not a non-negative number; using ${fallback}`);
    return fallback;
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

async function run(): Promise<void> {
  const relay = new RelayServer({
    host: process.env["RELAY_HOST"] ?? "0.0.0.0",
    port: num("PORT", 8080),
    maxChannels: num("RELAY_MAX_CHANNELS", 10_000),
    maxFrameBytes: num("RELAY_MAX_FRAME_BYTES", 65_536),
    enforceFrameSizes: flag("RELAY_ENFORCE_FRAME_SIZES", true),
    channelCreationPerMinute: num("RELAY_CHANNEL_CREATE_PER_MIN", 30),
    connectionsPerMinute: num("RELAY_CONNECT_PER_MIN", 240),
    cookieThreshold: num("RELAY_COOKIE_THRESHOLD", 600),
    pingIntervalMs: num("RELAY_PING_INTERVAL_MS", RELAY_PING_INTERVAL_MS),
    soloTimeoutMs: num("RELAY_SOLO_TIMEOUT_MS", 0),
    trustProxy: num("RELAY_TRUST_PROXY", 0),
    log: (line) => console.log(line),
  });

  const { url } = await relay.listen();
  console.log(`health: ${url}/healthz`);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: closing ${relay.statistics().sockets} sockets`);
    relay.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/**
 * Run when executed, stay quiet when imported by a test. Compare real paths:
 * `piorbit-relay` is a bin symlink, so `argv[1]` and `import.meta.url` are
 * different strings pointing at the same file.
 */
function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
