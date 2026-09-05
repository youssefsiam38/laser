#!/usr/bin/env node
/**
 * Worker process entry (M0-T6). One process = one project directory.
 * Transport: JSON-RPC over stdio (LF-delimited), later a Unix socket.
 * The host spawns this from the bundled Node runtime with the pinned Pi.
 */
import { LineDecoder } from "@piorbit/protocol";

const decoder = new LineDecoder();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of decoder.push(chunk)) {
    // TODO(M0-T6): parse JSON-RPC, dispatch to a SessionDriver, write responses/notifications to stdout.
    void line;
  }
});
process.stdin.on("end", () => process.exit(0));
