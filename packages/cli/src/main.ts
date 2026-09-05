#!/usr/bin/env node
/**
 * `piorbit` — the entry point.
 *
 * Sets `process.exitCode` rather than calling `process.exit`, so buffered
 * stdout reaches a pipe before the process goes. The one command that must not
 * come back here is `pi`, which replaces this process's exit status with the
 * child's (see src/pi.ts).
 */
import { migrateFormerIdentities } from "@piorbit/host";
import { PRODUCT_NAME } from "@piorbit/protocol";
import { run } from "./cli.js";

// A closed pipe (`piorbit sessions | head`) is a normal end, not a crash.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

// If this product was renamed, the person's sessions, settings and paired
// devices are still under the old directory name. This has to happen here and
// not only in the daemon: `doctor` reads auth.json and *creates* the state
// directory, so a worried person running it before the app's first start would
// otherwise be told they are signed out, and would make the very directory that
// stops the migration from ever running (MX-T7, D-36). With no former names it
// does nothing.
for (const line of migrateFormerIdentities().lines) process.stderr.write(`${line}\n`);

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${PRODUCT_NAME} failed unexpectedly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
