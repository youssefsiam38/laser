import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, retainDir, extra] = process.argv.slice(2);
if (!mode || !retainDir) process.exit(2);

function identity(pid) {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return bootId && after[19] ? `linux:${bootId}:${after[19]}` : undefined;
  } catch {
    return undefined;
  }
}

function holdLock() {
  const path = join(retainDir, ".store.lock");
  const fd = openSync(path, "wx", 0o600);
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    purpose: "retain-store",
    ...(identity(process.pid) ? { identity: identity(process.pid) } : {}),
  };
  writeFileSync(fd, `${JSON.stringify(record)}\n`);
  fsyncSync(fd);
  process.stdout.write(`${JSON.stringify({ phase: "ready", pid: process.pid })}\n`);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0);
  closeSync(fd);
}

async function loadRetain() {
  return import(new URL("../src/runtime-generation-retain.js", import.meta.url).href);
}

async function sweepLoop() {
  const { sweepRuntimeGenerations } = await loadRetain();
  process.stdout.write(`${JSON.stringify({ phase: "ready", pid: process.pid })}\n`);
  const timer = setInterval(() => {
    try { sweepRuntimeGenerations({ retainDir }); }
    catch { /* lock contention or empty store */ }
  }, 15);
  await new Promise((resolve) => {
    process.on("SIGTERM", () => { clearInterval(timer); resolve(); });
    process.on("SIGINT", () => { clearInterval(timer); resolve(); });
  });
}

async function retainOnce() {
  if (!extra) process.exit(2);
  const config = JSON.parse(readFileSync(extra, "utf8"));
  const { retainRuntimeGeneration, RuntimeRetainError } = await loadRetain();
  const wait = new Int32Array(new SharedArrayBuffer(4));
  try {
    const result = retainRuntimeGeneration({
      retainDir,
      selected: config.selected,
      manifest: config.manifest,
      launchId: config.launchId,
      launcherLeaseId: config.launcherLeaseId,
      expectedRetainedDigest: config.expectedRetainedDigest,
      onBoundary(boundary) {
        if (boundary !== (config.waitBoundary ?? "before-publish") || !config.goFile) return;
        process.stdout.write(`${JSON.stringify({ phase: "before-publish", pid: process.pid })}\n`);
        while (!existsSync(config.goFile)) Atomics.wait(wait, 0, 0, 50);
      },
    });
    process.stdout.write(`${JSON.stringify({
      phase: "done",
      pid: process.pid,
      installRoot: result.reference.installRoot,
      retainedDigest: result.retainedDigest,
    })}\n`);
  } catch (error) {
    const reason = error instanceof RuntimeRetainError ? error.reason : "failed-corrupt";
    process.stdout.write(`${JSON.stringify({
      phase: "error",
      pid: process.pid,
      reason,
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}

if (mode === "hold-lock") holdLock();
else if (mode === "sweep-loop") await sweepLoop();
else if (mode === "retain") await retainOnce();
else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
