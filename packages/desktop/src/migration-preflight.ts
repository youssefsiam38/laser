import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import {
  MigrationActivationError,
  prepareInstalledRuntime,
  type InstalledRuntimeLaunch,
  type LaserPaths,
  type MigrationLaunchEvent,
} from "@lasercode/cli";

interface Input { paths: LaserPaths; currentEntry: string }
type Message =
  | { type: "event"; event: MigrationLaunchEvent }
  | { type: "result"; result: InstalledRuntimeLaunch }
  | { type: "error"; message: string; updateId?: string; snapshot?: "available" | "none" | "restored" };

if (!isMainThread) {
  const input = workerData as Input;
  try {
    const result = prepareInstalledRuntime(input.paths, input.currentEntry, {
      onMigrationEvent: (event) => parentPort?.postMessage({ type: "event", event } satisfies Message),
    });
    parentPort?.postMessage({ type: "result", result } satisfies Message);
  } catch (error) {
    parentPort?.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof MigrationActivationError ? { updateId: error.updateId, snapshot: error.snapshot } : {}),
    } satisfies Message);
  }
}

/** Whole-unit copy and hashing stay off Electron's main thread. */
export function prepareInstalledRuntimeOffMain(
  paths: LaserPaths,
  currentEntry: string,
  onEvent?: (event: MigrationLaunchEvent) => void,
  workerUrl?: URL,
): Promise<InstalledRuntimeLaunch> {
  return new Promise((resolve, reject) => {
    const adjacent = new URL("./migration-preflight.js", import.meta.url);
    const resolvedWorker = workerUrl ?? (existsSync(fileURLToPath(adjacent))
      ? adjacent
      : new URL("../dist/migration-preflight.js", import.meta.url));
    const worker = new Worker(resolvedWorker, { workerData: { paths, currentEntry } satisfies Input });
    let settled = false;
    worker.on("message", (message: Message) => {
      if (message.type === "event") {
        onEvent?.(message.event);
        return;
      }
      settled = true;
      if (message.type === "result") resolve(message.result);
      else reject(message.updateId && message.snapshot
        ? new MigrationActivationError(message.updateId, message.snapshot, message.message)
        : new Error(message.message));
    });
    worker.once("error", (error) => { if (!settled) reject(error); });
    worker.once("exit", (code) => { if (!settled) reject(new Error(`migration preflight worker exited with code ${code}`)); });
  });
}
