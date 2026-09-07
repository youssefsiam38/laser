import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read uncached: an import would keep returning the old in-memory manifest. */
export function installedHostVersion(resources: string): string | undefined {
  return readVersion(join(resources, "app.asar.unpacked/node_modules/@lasercode/cli/package.json"));
}

export function readVersion(path: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version = (value as { version?: unknown } | null)?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ? version : undefined;
  } catch { return undefined; }
}

/** Only post-install publishes this marker, after every package file is in place. */
export class NativeUpdateWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private announced: string | undefined;
  constructor(private readonly options: {
    resources: string;
    running: string;
    onReady: (version: string) => void;
  }) {}
  check(): string | undefined {
    const version = readVersion(join(this.options.resources, "native-update.json"));
    if (!version || version === this.options.running) return undefined;
    if (version !== this.announced) {
      this.announced = version;
      this.options.onReady(version);
    }
    return version;
  }
  start(): void {
    this.stop();
    this.check();
    this.timer = setInterval(() => this.check(), 30_000);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
