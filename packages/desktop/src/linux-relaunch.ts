/**
 * Electron's Linux app.relaunch() uses Chromium's relauncher, which sets
 * PR_SET_NO_NEW_PRIVS before exec. That bit reaches the next host, worker and
 * shell and prevents sudo forever in that process tree. Use stock Node instead;
 * the renderer sandbox and all pre-existing OS restrictions remain untouched.
 */
import { BINARY_NAME, PRODUCT_NAME } from "@lasercode/protocol";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only these deliberately person-facing messages may reach the native dialog. */
export class LinuxRelaunchError extends Error {
  override readonly name = "LinuxRelaunchError";
}

export interface RelaunchCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PreparedRelaunch {
  commit(): Promise<void>;
  cancel(): void;
}

/** The launcher reapplies Linux startup policy with the original arguments. */
export function linuxRelaunchCommand(options: {
  packaged: boolean; execPath: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv;
}): RelaunchCommand {
  return {
    // A mounted AppImage disappears when the old runtime exits. Relaunch the
    // durable image, not the launcher inside its soon-to-be-unmounted AppDir.
    executable: options.packaged
      ? options.env["APPIMAGE"] || join(dirname(options.execPath), BINARY_NAME)
      : options.execPath,
    args: options.argv.slice(1),
    cwd: options.cwd,
    env: { ...options.env },
  };
}

export function assertRelaunchPrivileges(status = readFileSync("/proc/self/status", "utf8")): void {
  const flag = /^NoNewPrivs:\s*([01])\s*$/m.exec(status)?.[1];
  if (flag === "0") return;
  if (flag === "1") {
    throw new LinuxRelaunchError(
      `${PRODUCT_NAME} is running with an inherited restriction that prevents sudo. ` +
      "When your work is saved, quit the app completely, including its tray icon, and open it from the applications menu. " +
      "Restarting from this process cannot remove the restriction.",
    );
  }
  throw new LinuxRelaunchError("The app could not verify its restart permissions. Keep working, or quit completely and open it from the applications menu.");
}

/** Must prepare BEFORE stopping the host or destroying any window/tray. */
export async function prepareLinuxRelaunch(options: {
  nodeBinary: string; command: RelaunchCommand; logFile: string;
}): Promise<PreparedRelaunch> {
  assertRelaunchPrivileges();
  // Read before shutdown and transmit already-loaded code: native installs can
  // replace the asar. Stock Node cannot read inside it, Electron's fs can.
  const source = readFileSync(new URL("./relaunch-helper.cjs", import.meta.url), "utf8");
  const env = { ...options.command.env };
  // These may configure the app, but must not inject code or an inspector into
  // the small stock-Node handoff. The replacement gets the original env via IPC.
  delete env["NODE_OPTIONS"];
  delete env["NODE_CHANNEL_FD"];
  delete env["NODE_CHANNEL_SERIALIZATION_MODE"];
  delete env["ELECTRON_RUN_AS_NODE"];
  const fd = openSync(options.logFile, "a", 0o600);
  const child = (() => {
    try {
      return spawn(options.nodeBinary, ["--input-type=commonjs", "--eval", source], {
        cwd: options.command.cwd, env, detached: true, stdio: ["ignore", fd, fd, "ipc"],
      });
    } finally { closeSync(fd); }
  })();
  let failure: Error | undefined;
  let pending: { expected: string; resolve(): void; reject(error: Error): void } | undefined;
  let cancelled = false;
  let committed = false;
  const fail = () => {
    failure = new LinuxRelaunchError("The restart helper could not start or stopped responding. Keep working, or quit completely and open the app from the applications menu.");
    pending?.reject(failure);
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.on("message", (message: unknown) => {
    if ((message as { type?: string } | null)?.type === pending?.expected) pending?.resolve();
  });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    child.kill(); // only this owned helper, never the app/host/replacement
  };
  const exchange = (type: string, expected: string): Promise<void> => new Promise((resolve, reject) => {
    if (failure || cancelled) { reject(failure ?? new Error("Restart was cancelled.")); return; }
    const timer = setTimeout(() => { cancel(); fail(); }, 10_000);
    const settle = (error?: Error) => {
      clearTimeout(timer);
      pending = undefined;
      if (error) reject(error); else resolve();
    };
    pending = { expected, resolve: () => settle(), reject: (error) => settle(error) };
    child.send({ type, ...(type === "prepare" ? { launch: options.command } : {}) }, (error) => { if (error) fail(); });
  });
  try { await exchange("prepare", "ready"); }
  catch (error) { cancel(); throw error; }
  return {
    cancel,
    async commit() {
      if (committed) throw new Error("Restart was already committed.");
      await exchange("commit", "committed");
      committed = true;
      child.unref();
      child.channel?.unref();
      // Keep IPC connected until the app actually exits. The helper also waits
      // for /proc start-time identity to disappear before launching a successor.
    },
  };
}
