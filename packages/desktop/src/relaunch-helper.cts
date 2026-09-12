/**
 * Stock-Node Linux restart handoff. The desktop reads the compiled source
 * through Electron's asar-aware fs and supplies it to Node via --eval. No
 * imports from the app, no temporary executable, no Chromium relauncher.
 *
 * Preparation is inert. Only commit followed by the original process exiting
 * starts the replacement. Disconnect before commit (including a crash) cancels.
 */
import fs = require("node:fs");
import childProcess = require("node:child_process");
const { accessSync, constants, readFileSync, statSync } = fs;
const { spawn } = childProcess;

type Launch = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
const originalPid = process.ppid;
let originalStart: string;
let launch: Launch | undefined;
let committed = false;
let disconnected = false;
let deadline = Date.now() + 120_000;

function identity(pid: number): { start: string; state: string } | undefined {
  try {
    // comm may contain spaces and ')'; fields after its LAST ')' start at 3.
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0]!, start: fields[19]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function fail(_error: unknown): never {
  // No configuration, arguments or environment in diagnostics. The parent
  // observes our exit; after its exit this sentence remains in the desktop log.
  console.error("Application restart failed. Open the app from the applications menu.");
  process.exit(1);
}

try {
  const parent = identity(originalPid);
  if (!parent) throw new Error("Parent already exited");
  originalStart = parent.start;
  process.on("message", (message: unknown) => {
    try {
      const data = message as { type?: string; launch?: Launch } | null;
      if (data?.type === "prepare" && !launch) {
        const next = data.launch;
        if (!next || typeof next.executable !== "string" || !next.executable.startsWith("/") ||
            !Array.isArray(next.args) || !next.args.every((arg) => typeof arg === "string") ||
            typeof next.cwd !== "string" || !next.env || typeof next.env !== "object") {
          throw new Error("Invalid launch configuration");
        }
        accessSync(next.executable, constants.X_OK);
        if (!statSync(next.cwd).isDirectory()) throw new Error("Working directory is unavailable");
        launch = next;
        process.send?.({ type: "ready" });
      } else if (data?.type === "commit" && launch && !committed) {
        committed = true;
        deadline = Date.now() + 60_000;
        process.send?.({ type: "committed" });
      } else if (data?.type === "cancel") {
        process.exit(0);
      } else {
        throw new Error("Invalid restart transition");
      }
    } catch (error) { fail(error); }
  });
  process.on("disconnect", () => {
    disconnected = true;
    if (!committed) process.exit(0);
  });
  setInterval(() => {
    try {
      if (Date.now() > deadline) throw new Error("Restart handoff expired");
      if (!committed || !disconnected || !launch) return;
      const parent = identity(originalPid);
      if (parent?.start === originalStart && parent.state !== "Z" && parent.state !== "X") return;
      const child = spawn(launch.executable, launch.args, {
        cwd: launch.cwd, env: launch.env, detached: true, stdio: "ignore",
      });
      child.once("error", fail);
      child.once("spawn", () => { child.unref(); process.exit(0); });
      // Prevent another poll from launching a second replacement.
      committed = false;
    } catch (error) { fail(error); }
  }, 50);
} catch (error) { fail(error); }
