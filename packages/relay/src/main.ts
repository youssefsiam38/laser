#!/usr/bin/env node
/**
 * Relay (M6-T4). Rules that are fixed:
 *  - Exactly two sockets per channel id; a third is refused.
 *  - Forward zero bytes until both sides are present.
 *  - Per-IP limits on channel creation, separate from connection attempts.
 *  - WireGuard-style cookies under load (MAC of source IP under a 2-minute rotating secret).
 *  - permessage-deflate disabled. App-level ping every 20 s. Railway serverless off.
 *  - Never parse payloads beyond the channel id. No crypto library in this package.
 */
export const RELAY_PING_INTERVAL_MS = 20_000;
export const RELAY_MAX_SOCKETS_PER_CHANNEL = 2;
export const RELAY_PORT = Number(process.env["PORT"] ?? 8080);

console.log(`piorbit relay scaffold: would listen on ${RELAY_PORT}`);
