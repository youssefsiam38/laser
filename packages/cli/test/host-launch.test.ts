import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaserPaths } from "../src/config.js";
import { hostDaemonArgv, nodeLaunchEnvironment, runForegroundHost } from "../src/host-control.js";

function paths(base: string): LaserPaths {
  return {
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    hostFile: join(base, "state", "host.json"),
    logFile: join(base, "state", "host.log"),
    host: "127.0.0.1",
    port: 0,
    portIsExplicit: false,
  };
}

describe("host Node launches", () => {
  it("places the exact ceiling before the CLI entry and removes inherited Node options", () => {
    const argv = hostDaemonArgv(paths("/tmp/example"), 4096 * 1024 * 1024, "/app/cli.mjs");
    expect(argv.slice(0, 3)).toEqual(["--max-old-space-size=448", "/app/cli.mjs", "__daemon"]);
    expect(nodeLaunchEnvironment({ HOME: "/tmp/home", NODE_OPTIONS: "--max-old-space-size=1", Node_Options: "--trace-warnings" }))
      .toEqual({ HOME: "/tmp/home" });
  });

  it.each(["SIGINT", "SIGTERM"] as const)("forwards %s and awaits the child's clean exit", async (signal) => {
    const root = mkdtempSync(join(tmpdir(), "host-signal-"));
    const entry = join(root, "signal.mjs");
    const ready = join(root, "ready");
    const stopped = join(root, "stopped");
    writeFileSync(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.READY, "ready");\nfor (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { writeFileSync(process.env.STOPPED, signal); process.exit(0); });\nsetInterval(() => {}, 1000);\n`);
    const signals = new EventEmitter();
    try {
      const running = runForegroundHost(paths(root), {
        entry,
        capacityBytes: 4096 * 1024 * 1024,
        env: { READY: ready, STOPPED: stopped },
        signalSource: signals,
      });
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);
      signals.emit(signal);
      await expect(running).resolves.toEqual({ code: 0, signal: null });
      expect(readFileSync(stopped, "utf8")).toBe(signal);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("foreground re-exec runs in a fresh bounded isolate rather than this process", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-launch-"));
    const entry = join(root, "probe.mjs");
    const output = join(root, "result.json");
    writeFileSync(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT, JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS }));\n`);
    try {
      const result = await runForegroundHost(paths(root), {
        entry,
        capacityBytes: 4096 * 1024 * 1024,
        env: { OUTPUT: output, NODE_OPTIONS: "--max-old-space-size=1" },
      });
      expect(result).toEqual({ code: 0, signal: null });
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ execArgv: ["--max-old-space-size=448"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
