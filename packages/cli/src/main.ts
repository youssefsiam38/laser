#!/usr/bin/env node
/**
 * `piorbit` — the entry point.
 *
 * Sets `process.exitCode` rather than calling `process.exit`, so buffered
 * stdout reaches a pipe before the process goes. The one command that must not
 * come back here is `pi`, which replaces this process's exit status with the
 * child's (see src/pi.ts).
 */
import { run } from "./cli.js";

// A closed pipe (`piorbit sessions | head`) is a normal end, not a crash.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`piorbit failed unexpectedly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
