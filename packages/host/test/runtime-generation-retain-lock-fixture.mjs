import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, retainDir] = process.argv.slice(2);
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

async function sweepLoop() {
  const { sweepRuntimeGenerations } = await import(new URL("../dist/runtime-generation-retain.js", import.meta.url).href);
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

if (mode === "hold-lock") holdLock();
else if (mode === "sweep-loop") await sweepLoop();
else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
