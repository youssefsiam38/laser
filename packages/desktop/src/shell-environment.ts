import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { environmentOverlay, envVar } from "@lasercode/protocol";

const MAX_OUTPUT = 1_048_576;

/** Exported variables only: no aliases, shell functions or per-command startup. */
export async function resolveShellEnvironment(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  log: (line: string) => void;
}): Promise<Record<string, string>> {
  const inherited = options.env ?? process.env;
  if ((options.platform ?? process.platform) === "win32" || inherited[envVar("RESOLVE_SHELL_ENV")] === "0") return {};
  // Remove app/engine pins before executing startup scripts. Never use Electron
  // as the environment printer: NODE_OPTIONS and startup output are untrusted.
  const env = environmentOverlay(inherited);
  delete env["BASH_ENV"];
  delete env["ENV"];
  const marker = randomUUID();
  const start = `__ENV_START_${marker}__`;
  const end = `__ENV_END_${marker}__`;
  const result = await new Promise<Record<string, string> | undefined>((resolve) => {
    const child = spawn(inherited["SHELL"] || "/bin/bash", ["-ilc", `printf '${start}\\0'; /usr/bin/env -0 && printf '${end}\\0'`], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true,
    });
    let done = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (value?: Record<string, string>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Also collect grandchildren from a startup script that hung or left a
      // background process holding a pipe. Never leave a profile running.
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 10_000);
    child.on("error", () => finish());
    child.stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) return finish();
      chunks.push(chunk);
      // The marker, not process/pipe closure, completes the snapshot. A profile
      // may leave a grandchild holding stdout or a logout hook may fail later.
      const output = Buffer.concat(chunks).toString("utf8");
      const from = output.indexOf(`${start}\0`);
      const to = output.indexOf(`${end}\0`, from + start.length + 1);
      if (from < 0 || to < 0) return;
      const entries = output.slice(from + start.length + 1, to).split("\0").filter(Boolean);
      const variables: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const entry of entries) {
        const equals = entry.indexOf("=");
        if (equals > 0) variables[entry.slice(0, equals)] = entry.slice(equals + 1);
      }
      finish(environmentOverlay(variables));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) finish();
    });
    child.on("close", () => finish());
  });
  if (!result) {
    options.log("Shell environment unavailable; keeping the current environment.");
    return {};
  }
  const known = ["PATH", "SHELL", "LANG"].filter((name) => name in result);
  options.log(`Shell environment resolved: ${Object.keys(result).length} variables; ${known.join(", ")}.`);
  return result;
}
