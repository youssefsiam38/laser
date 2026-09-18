#!/usr/bin/env node
// `pnpm verify`: the direction check and build run first, because everything
// else reads built output; then typecheck, every package's tests and the
// script suites run at the same time. Each task's output is buffered and
// printed whole when it ends, so parallel logs never interleave.
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { appLaunchEnvironmentScrubMessage, scrubAppLaunchEnvironment } from "./launch-environment.mjs";

const serial = [
  ["direction", "pnpm direction:check"],
  ["build", "pnpm -r build"],
];
// Package tests do not depend on one another at runtime, so topological order
// only makes them wait. Each vitest fans out across every core by default, so
// concurrent packages oversubscribed the machine and 5 s timeouts failed tests
// that pass alone. Split the cores between the packages running at once,
// leaving a little for typecheck.
const cores = availableParallelism();
const packageConcurrency = Math.max(1, Math.min(3, Math.floor(cores / 8)));
const workersPerPackage = String(Math.max(1, Math.floor((cores - 2) / packageConcurrency)));
const testEnv = { VITEST_MAX_THREADS: workersPerPackage, VITEST_MAX_FORKS: workersPerPackage };
const parallel = [
  ["typecheck", "pnpm -r typecheck"],
  ["test", `pnpm -r --no-sort --workspace-concurrency=${packageConcurrency} test`, testEnv],
  ["release tests", "pnpm test:release"],
  ["browser-check tests", "pnpm test:browser-check"],
];

function run([name, command, env = {}], baseEnv) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, env: { ...baseEnv, FORCE_COLOR: baseEnv.FORCE_COLOR ?? "1", ...env } });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("close", (code, signal) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const ok = code === 0;
      process.stdout.write(`\n── ${name} (${command}) ${ok ? "passed" : `FAILED (${signal ?? `exit ${code}`})`} in ${seconds}s\n`);
      if (!ok || process.env.VERIFY_VERBOSE === "1") process.stdout.write(Buffer.concat(chunks));
      resolve({ name, ok, seconds });
    });
  });
}

const scrubbed = scrubAppLaunchEnvironment(process.env);
process.stderr.write(appLaunchEnvironmentScrubMessage("verify", scrubbed.removed));

const started = performance.now();
const results = [];
for (const task of serial) {
  const result = await run(task, scrubbed.env);
  results.push(result);
  if (!result.ok) break;
}
if (results.every((result) => result.ok)) {
  results.push(...await Promise.all(parallel.map((task) => run(task, scrubbed.env))));
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\nverify ${failed.length ? `FAILED: ${failed.map((result) => result.name).join(", ")}` : "passed"} in ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
process.exit(failed.length ? 1 : 0);
