import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  UpdateTransactionStore,
  cliEntry,
  readRuntimeGenerationPointer,
  runtimeReferenceFromManifest,
  runtimeUpdateId,
  stageRuntimeGeneration,
  verifyRuntimeGeneration,
} from "@lasercode/cli";

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

export interface NativeUpdateMarker {
  schemaVersion: 1;
  version: string;
  buildIdentity: string;
  generationId: string;
  manifestDigest: string;
  updateId: string;
}

const HASH = /^[0-9a-f]{64}$/;

export function readNativeUpdateMarker(path: string): NativeUpdateMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<NativeUpdateMarker>;
    if (value.schemaVersion !== 1
      || !value.version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version)
      || typeof value.buildIdentity !== "string" || value.buildIdentity.length < 1 || value.buildIdentity.length > 200
      || !HASH.test(value.generationId ?? "")
      || !HASH.test(value.manifestDigest ?? "")
      || !HASH.test(value.updateId ?? "")) return undefined;
    return value as NativeUpdateMarker;
  } catch { return undefined; }
}

/** Only post-install publishes this marker, after every package file is in place. */
export class NativeUpdateWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private announced: string | undefined;
  constructor(private readonly options: {
    resources: string;
    stateDir: string;
    running: string;
    currentEntry?: string;
    onReady: (marker: NativeUpdateMarker) => void;
  }) {}
  check(): NativeUpdateMarker | undefined {
    const marker = readNativeUpdateMarker(join(this.options.resources, "native-update.json"));
    if (!marker || marker.version === this.options.running) return undefined;
    try {
      const manifestPath = join(dirname(this.options.resources), "runtime-generation.json");
      const reference = runtimeReferenceFromManifest(manifestPath);
      const manifest = verifyRuntimeGeneration(reference, true);
      if (reference.generationId !== marker.generationId
        || reference.manifestDigest !== marker.manifestDigest
        || manifest.buildIdentity !== marker.buildIdentity
        || manifest.productVersion !== marker.version
        || runtimeUpdateId(manifest) !== marker.updateId) return undefined;
      const staged = stageRuntimeGeneration(this.options.stateDir, this.options.currentEntry ?? cliEntry());
      if (staged.current.generationId !== marker.generationId || staged.current.manifestDigest !== marker.manifestDigest) return undefined;
      const pointer = readRuntimeGenerationPointer(this.options.stateDir);
      if (!pointer) return undefined;
      const transactions = new UpdateTransactionStore(this.options.stateDir);
      let transaction = transactions.begin({
        updateId: marker.updateId,
        targetGenerationId: marker.generationId,
        previousGenerationId: pointer.active.generationId,
        targetVersion: marker.version,
        buildIdentity: marker.buildIdentity,
        manifestDigest: marker.manifestDigest,
      });
      if (transaction.phase === "discovered") transaction = transactions.transition(marker.updateId, "staging");
      if (transaction.phase === "staging") transactions.transition(marker.updateId, "staged");
    } catch {
      return undefined;
    }
    if (marker.updateId !== this.announced) {
      this.announced = marker.updateId;
      this.options.onReady(marker);
    }
    return marker;
  }
  start(): void {
    this.stop();
    this.check();
    this.timer = setInterval(() => this.check(), 30_000);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
