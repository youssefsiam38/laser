import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { laserDataDir } from "../src/paths.js";
import {
  runtimeReferenceFromManifest,
  writeRuntimeGenerationManifest,
} from "../src/runtime-generation.js";
import { processIdentity } from "../src/process-identity.js";
import {
  RUNTIME_RETAIN_DIR_NAME,
  RUNTIME_RETAIN_LEASES_DIR_NAME,
  RUNTIME_RETAINED_MARKER_NAME,
  RUNTIME_SUPPLEMENT_NAME,
  RuntimeRetainError,
  acquireRuntimeGenerationLease,
  bindRuntimeGenerationLease,
  evaluateRuntimeGenerationLease,
  nativeUidChildAcceptable,
  probeRetainedExecution,
  releaseRuntimeGenerationLease,
  resolveNativeRuntimeRetainDir,
  restartRuntimeGenerationLease,
  retainRuntimeGeneration,
  retainStoreLockPath,
  retainedRuntimeDigest,
  runtimeRetainDirFor,
  runtimeSupplementDigest,
  sanitizedRetainFileMode,
  scanRuntimeSupplement,
  selectRuntimeRetainParent,
  sweepRuntimeGenerations,
  verifyRetainedRuntimeGeneration,
  type RuntimeGenerationLease,
} from "../src/runtime-generation-retain.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const token = (): string => randomBytes(16).toString("hex");
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const lockFixture = fileURLToPath(new URL("./runtime-generation-retain-lock-fixture.mjs", import.meta.url));

function tmp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}

function packagedFixture(name = "one") {
  const root = tmp(`retain-src-${name}-`);
  const cli = join(root, "resources", "app.asar.unpacked", "cli.js");
  const worker = join(root, "resources", "app.asar.unpacked", "worker.js");
  const instructions = join(root, "resources", "app.asar.unpacked", "core-instructions.md");
  const node = join(root, "resources", "runtime", "node");
  write(cli, "cli");
  write(worker, `worker-${name}`);
  write(instructions, "instructions-v1");
  write(node, "#!/bin/sh\nexit 0\n", 0o755);
  chmodSync(node, 0o755);
  write(join(root, "resources", "native-update.json"), "{\"pending\":true}\n");
  write(join(root, "README.md"), "package-root\n");
  const written = writeRuntimeGenerationManifest({
    installRoot: root,
    files: [cli, worker, node],
    entries: {
      cli: "resources/app.asar.unpacked/cli.js",
      worker: "resources/app.asar.unpacked/worker.js",
      node: "resources/runtime/node",
    },
    productVersion: "1.0.0",
    buildIdentity: `build-${name}`,
  });
  return { root, cli, worker, instructions, node, ...written };
}

function hashesUnder(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string): void => {
    const absolute = rel ? join(root, ...rel.split("/")) : root;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(rel ? `${rel}/${name}` : name);
      return;
    }
    if (stat.isFile()) out[rel] = sha(readFileSync(absolute));
  };
  visit("");
  return out;
}

describe("retain materialization", () => {
  it("copies inventory and supplementary files, then keeps every retained byte after R is rewritten", () => {
    const source = packagedFixture("bytes");
    const retainDir = tmp("retain-dst-");
    const result = retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
      launcherLeaseId: token(),
    });
    const t = result.reference.installRoot;
    expect(t.startsWith(retainDir)).toBe(true);
    expect(existsSync(join(t, "resources/app.asar.unpacked/core-instructions.md"))).toBe(true);
    expect(existsSync(join(t, "resources/native-update.json"))).toBe(false);
    expect(existsSync(join(t, "README.md"))).toBe(false);
    const supplement = JSON.parse(readFileSync(join(t, RUNTIME_SUPPLEMENT_NAME), "utf8")) as {
      files: Array<{ path: string }>;
      supplementDigest: string;
    };
    expect(supplement.files.map((row) => row.path)).toEqual(["resources/app.asar.unpacked/core-instructions.md"]);
    expect(result.retainedDigest).toBe(retainedRuntimeDigest(
      result.reference.generationId,
      result.reference.manifestDigest,
      supplement.supplementDigest,
    ));
    const before = hashesUnder(t);
    writeFileSync(source.worker, "worker-rewritten");
    writeFileSync(source.instructions, "instructions-v2");
    writeFileSync(join(source.root, "README.md"), "new-readme");
    expect(hashesUnder(t)).toEqual(before);
    expect(readFileSync(join(t, "resources/app.asar.unpacked/core-instructions.md"), "utf8")).toBe("instructions-v1");
    expect(readFileSync(join(t, "resources/app.asar.unpacked/worker.js"), "utf8")).toBe("worker-bytes");
  });

  it("refuses a coherent supplement and metadata rewrite against the bound digest", () => {
    const source = packagedFixture("tamper");
    const retainDir = tmp("retain-tamper-");
    const result = retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    });
    const t = result.reference.installRoot;
    const instructions = join(t, "resources/app.asar.unpacked/core-instructions.md");
    writeFileSync(instructions, "tampered-instructions");
    const hashed = sha(readFileSync(instructions));
    const files = [{
      path: "resources/app.asar.unpacked/core-instructions.md",
      length: Buffer.byteLength("tampered-instructions"),
      sha256: hashed,
      mode: 0o644,
    }];
    writeFileSync(join(t, RUNTIME_SUPPLEMENT_NAME), `${JSON.stringify({
      schemaVersion: 1,
      generationId: result.reference.generationId,
      manifestDigest: result.reference.manifestDigest,
      supplementDigest: runtimeSupplementDigest(files),
      files,
    }, null, 2)}\n`);
    expect(() => verifyRetainedRuntimeGeneration(result.reference, result.retainedDigest))
      .toThrow(RuntimeRetainError);
  });

  it("fresh same-generation reuse checks the source-derived digest and refuses a coherent T rewrite", () => {
    const source = packagedFixture("reuse");
    const retainDir = tmp("retain-reuse-");
    const first = retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    });
    const t = first.reference.installRoot;
    writeFileSync(join(t, "resources/app.asar.unpacked/core-instructions.md"), "rewritten-in-t");
    const hashed = sha("rewritten-in-t");
    const files = [{
      path: "resources/app.asar.unpacked/core-instructions.md",
      length: Buffer.byteLength("rewritten-in-t"),
      sha256: hashed,
      mode: 0o644,
    }];
    writeFileSync(join(t, RUNTIME_SUPPLEMENT_NAME), `${JSON.stringify({
      schemaVersion: 1,
      generationId: first.reference.generationId,
      manifestDigest: first.reference.manifestDigest,
      supplementDigest: runtimeSupplementDigest(files),
      files,
    }, null, 2)}\n`);
    expect(() => retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    })).toThrow(RuntimeRetainError);
  });

  it("refuses old T when R changed and no bound digest is supplied", () => {
    const source = packagedFixture("moved");
    const retainDir = tmp("retain-moved-");
    const selected = runtimeReferenceFromManifest(source.path);
    retainRuntimeGeneration({
      retainDir,
      selected,
      manifest: source.manifest,
      launchId: token(),
    });
    writeFileSync(source.worker, "worker-next");
    writeRuntimeGenerationManifest({
      installRoot: source.root,
      files: [source.cli, source.worker, source.node],
      entries: source.manifest.entries,
      productVersion: "1.1.0",
      buildIdentity: "build-next",
    });
    expect(() => retainRuntimeGeneration({
      retainDir,
      selected,
      manifest: source.manifest,
      launchId: token(),
    })).toThrow(RuntimeRetainError);
    expect(readFileSync(join(retainDir, selected.generationId, "resources/app.asar.unpacked/worker.js"), "utf8"))
      .toBe("worker-moved");
  });

  it("aborts when the source is overwritten after the fd is opened", () => {
    const source = packagedFixture("race");
    const retainDir = tmp("retain-race-");
    expect(() => retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
      onBoundary(boundary, detail) {
        if (boundary === "source-opened" && detail.endsWith("worker.js")) writeFileSync(source.worker, "raced-bytes");
      },
    })).toThrow(RuntimeRetainError);
  });

  it("refuses symlink, fifo and traversal sources and strips setuid", () => {
    const source = packagedFixture("unsafe");
    chmodSync(source.node, 0o4755);
    expect(sanitizedRetainFileMode(lstatSync(source.node).mode)).toBe(0o755);
    const retainDir = tmp("retain-unsafe-");
    const result = retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    });
    const copiedNode = join(result.reference.installRoot, "resources/runtime/node");
    expect(lstatSync(copiedNode).mode & 0o7777).toBe(0o755);

    rmSync(source.cli);
    symlinkSync(source.worker, source.cli);
    expect(() => retainRuntimeGeneration({
      retainDir: tmp("retain-symlink-"),
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    })).toThrow(RuntimeRetainError);

    expect(() => retainRuntimeGeneration({
      retainDir: tmp("retain-escape-"),
      selected: { ...runtimeReferenceFromManifest(source.path), installRoot: source.root },
      manifest: {
        ...source.manifest,
        inventory: [...source.manifest.inventory, {
          path: "../escape.js",
          length: 1,
          sha256: "a".repeat(64),
          mtimeMs: 0,
        }],
      },
      launchId: token(),
    })).toThrow();

    const fifoRoot = packagedFixture("fifo");
    rmSync(fifoRoot.worker);
    const fifo = spawnSync("mkfifo", [fifoRoot.worker], { encoding: "utf8" });
    if (fifo.status === 0) {
      expect(() => retainRuntimeGeneration({
        retainDir: tmp("retain-fifo-"),
        selected: runtimeReferenceFromManifest(fifoRoot.path),
        manifest: fifoRoot.manifest,
        launchId: token(),
      })).toThrow(RuntimeRetainError);
    }
  });

  it("fails closed on an unexpected extra file in T", () => {
    const source = packagedFixture("extra");
    const retainDir = tmp("retain-extra-");
    const result = retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    });
    writeFileSync(join(result.reference.installRoot, "resources/app.asar.unpacked/extra.md"), "nope");
    expect(() => verifyRetainedRuntimeGeneration(result.reference, result.retainedDigest))
      .toThrow(RuntimeRetainError);
    writeFileSync(join(result.reference.installRoot, "sneaky.js"), "alert(1)");
    expect(() => verifyRetainedRuntimeGeneration(result.reference, result.retainedDigest))
      .toThrow(RuntimeRetainError);
  });

  it("keeps an empty supplement explicit so a missing file cannot drop the bind", () => {
    const root = tmp("retain-empty-src-");
    const cli = join(root, "resources", "app.asar.unpacked", "cli.js");
    const worker = join(root, "resources", "app.asar.unpacked", "worker.js");
    const node = join(root, "resources", "runtime", "node");
    write(cli, "cli");
    write(worker, "worker");
    write(node, "node", 0o755);
    const written = writeRuntimeGenerationManifest({
      installRoot: root,
      files: [cli, worker, node],
      entries: {
        cli: "resources/app.asar.unpacked/cli.js",
        worker: "resources/app.asar.unpacked/worker.js",
        node: "resources/runtime/node",
      },
      productVersion: "1.0.0",
      buildIdentity: "empty",
    });
    expect(scanRuntimeSupplement(root, written.manifest)).toEqual([]);
    const result = retainRuntimeGeneration({
      retainDir: tmp("retain-empty-dst-"),
      selected: runtimeReferenceFromManifest(written.path),
      manifest: written.manifest,
      launchId: token(),
    });
    const supplement = JSON.parse(readFileSync(join(result.reference.installRoot, RUNTIME_SUPPLEMENT_NAME), "utf8"));
    expect(supplement.files).toEqual([]);
    rmSync(join(result.reference.installRoot, RUNTIME_SUPPLEMENT_NAME));
    expect(() => verifyRetainedRuntimeGeneration(result.reference, result.retainedDigest))
      .toThrow(RuntimeRetainError);
  });
});

describe("retain isolation and native parent", () => {
  it("never writes the default user data directory from a custom retain parent", () => {
    const dataDir = laserDataDir();
    const existed = existsSync(dataDir);
    const retainBefore = existed && existsSync(join(dataDir, RUNTIME_RETAIN_DIR_NAME));
    const source = packagedFixture("isolate");
    const stateDir = tmp("retain-state-");
    const retainDir = runtimeRetainDirFor(stateDir);
    retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    });
    expect(retainDir.startsWith(stateDir)).toBe(true);
    if (!existed) expect(existsSync(dataDir)).toBe(false);
    else expect(existsSync(join(dataDir, RUNTIME_RETAIN_DIR_NAME))).toBe(retainBefore);
  });

  it("rejects a symlinked native parent, a squatted uid dir, and a world-writable uid dir", () => {
    const configured = tmp("retain-configured-");
    const planted = tmp("retain-native-");
    const linked = join(dirname(planted), `native-link-${token()}`);
    roots.push(linked);
    symlinkSync(planted, linked);
    expect(resolveNativeRuntimeRetainDir(linked)).toBeUndefined();
    expect(selectRuntimeRetainParent(configured, linked)).toBe(configured);

    const uid = process.getuid?.();
    if (uid === undefined) return;
    const parent = tmp("retain-native-parent-");
    chmodSync(parent, 0o1733);
    const child = join(parent, String(uid));
    mkdirSync(child, { mode: 0o777 });
    chmodSync(child, 0o777);
    expect(nativeUidChildAcceptable(lstatSync(child), uid)).toBe(false);
    expect(resolveNativeRuntimeRetainDir(parent, uid)).toBeUndefined();
    expect(selectRuntimeRetainParent(configured, parent)).toBe(configured);
    expect(lstatSync(child).mode & 0o777).toBe(0o777);

    rmSync(child, { recursive: true, force: true });
    symlinkSync(configured, child);
    expect(resolveNativeRuntimeRetainDir(parent, uid)).toBeUndefined();

    rmSync(child, { force: true });
    const other = nativeUidChildAcceptable({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: uid + 1,
      mode: 0o40700,
    }, uid);
    expect(other).toBe(false);
  });
});

describe("exec probe", () => {
  it("accepts a real node binary and fails closed on a non-executable payload", () => {
    probeRetainedExecution(process.execPath);
    const junk = join(tmp("retain-probe-"), "not-node");
    writeFileSync(junk, "not a runtime\n");
    expect(() => probeRetainedExecution(junk)).toThrowError(RuntimeRetainError);
    try { probeRetainedExecution(junk); }
    catch (error) { expect((error as RuntimeRetainError).reason).toBe("failed-exec"); }
  });
});

describe("leases and sweep", () => {
  function lease(over: Partial<RuntimeGenerationLease> = {}): RuntimeGenerationLease {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      launcherLeaseId: token(),
      launchId: token(),
      generationId: "a".repeat(64),
      executionRoot: "/tmp/t",
      retainedDigest: "b".repeat(64),
      state: "bound",
      launcherPid: process.pid,
      launcherIdentity: processIdentity(process.pid) ?? "missing",
      createdAt: now,
      updatedAt: now,
      ...over,
    };
  }

  it("treats either live matching identity as protection and PID reuse as dead", () => {
    const identity = processIdentity(process.pid);
    expect(identity).toBeDefined();
    expect(evaluateRuntimeGenerationLease(lease({
      launcherPid: process.pid,
      launcherIdentity: identity!,
      daemonPid: 999_999_999,
      daemonIdentity: "linux:dead:1",
    }))).toBe("protected");
    expect(evaluateRuntimeGenerationLease(lease({
      launcherPid: 999_999_999,
      launcherIdentity: "linux:dead:1",
      daemonPid: process.pid,
      daemonIdentity: identity!,
    }))).toBe("protected");
    expect(evaluateRuntimeGenerationLease(lease({
      launcherPid: process.pid,
      launcherIdentity: "linux:other:1",
      daemonPid: undefined,
      daemonIdentity: undefined,
    }))).toBe("reclaimable");
  });

  it("fails closed when identity cannot be computed for a live process", () => {
    expect(evaluateRuntimeGenerationLease(lease(), {
      identity: () => undefined,
      alive: () => true,
    })).toBe("unknown");
  });

  it("keeps a launcher-live daemon-dead tree and a detached daemon-live tree, and cleans both-dead", () => {
    const source = packagedFixture("lease");
    const retainDir = tmp("retain-lease-");
    const identity = processIdentity(process.pid)!;
    const liveLauncher = token();
    const liveDaemon = token();
    const deadBoth = token();
    const first = retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
      launcherLeaseId: liveLauncher,
    });
    bindRuntimeGenerationLease({
      retainDir,
      launchId: token(),
      launcherLeaseId: liveLauncher,
      pid: 999_999_999,
      identity: "linux:dead-daemon:1",
    });
    const daemonRoot = join(retainDir, "c".repeat(64));
    mkdirSync(daemonRoot, { recursive: true });
    writeFileSync(join(daemonRoot, RUNTIME_RETAINED_MARKER_NAME), "RETAINED\n");
    acquireRuntimeGenerationLease({
      retainDir,
      launchId: token(),
      launcherLeaseId: liveDaemon,
      generationId: "c".repeat(64),
      executionRoot: daemonRoot,
      retainedDigest: "d".repeat(64),
    });
    bindRuntimeGenerationLease({
      retainDir,
      launchId: token(),
      launcherLeaseId: liveDaemon,
      pid: process.pid,
      identity,
    });
    writeFileSync(join(join(retainDir, RUNTIME_RETAIN_LEASES_DIR_NAME), `${liveDaemon}.json`), `${JSON.stringify({
      ...JSON.parse(readFileSync(join(retainDir, RUNTIME_RETAIN_LEASES_DIR_NAME, `${liveDaemon}.json`), "utf8")),
      launcherPid: 999_999_995,
      launcherIdentity: "linux:dead-launcher:1",
      daemonPid: process.pid,
      daemonIdentity: identity,
      state: "bound",
    })}\n`);
    const deadRoot = join(retainDir, "e".repeat(64));
    mkdirSync(deadRoot, { recursive: true });
    writeFileSync(join(deadRoot, RUNTIME_RETAINED_MARKER_NAME), "RETAINED\n");
    acquireRuntimeGenerationLease({
      retainDir,
      launchId: token(),
      launcherLeaseId: deadBoth,
      generationId: "e".repeat(64),
      executionRoot: deadRoot,
      retainedDigest: "f".repeat(64),
    });
    const leases = join(retainDir, RUNTIME_RETAIN_LEASES_DIR_NAME);
    writeFileSync(join(leases, `${deadBoth}.json`), `${JSON.stringify({
      ...JSON.parse(readFileSync(join(leases, `${deadBoth}.json`), "utf8")),
      launcherPid: 999_999_998,
      launcherIdentity: "linux:dead:1",
      daemonPid: 999_999_997,
      daemonIdentity: "linux:dead:2",
      state: "bound",
    })}\n`);
    sweepRuntimeGenerations({ retainDir });
    expect(existsSync(first.reference.installRoot)).toBe(true);
    expect(existsSync(daemonRoot)).toBe(true);
    expect(existsSync(deadRoot)).toBe(false);
    releaseRuntimeGenerationLease({ retainDir, launcherLeaseId: liveLauncher });
  });

  it("does not delete T when identity probes cannot decide", () => {
    const retainDir = tmp("retain-unknown-");
    const executionRoot = join(retainDir, "a".repeat(64));
    mkdirSync(executionRoot, { recursive: true });
    writeFileSync(join(executionRoot, RUNTIME_RETAINED_MARKER_NAME), "RETAINED\n");
    acquireRuntimeGenerationLease({
      retainDir,
      launchId: token(),
      launcherLeaseId: token(),
      generationId: "a".repeat(64),
      executionRoot,
      retainedDigest: "b".repeat(64),
    });
    sweepRuntimeGenerations({
      retainDir,
      probes: { identity: () => undefined, alive: () => true },
    });
    expect(existsSync(executionRoot)).toBe(true);
  });
});

describe("store lock", () => {
  it("recovers a stale lock and refuses to steal a live holder", async () => {
    const source = packagedFixture("lock");
    const retainDir = tmp("retain-lock-");
    writeFileSync(retainStoreLockPath(retainDir), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_996,
      identity: "linux:stale:1",
      createdAt: new Date().toISOString(),
      purpose: "retain-store",
    })}\n`);
    expect(() => retainRuntimeGeneration({
      retainDir,
      selected: runtimeReferenceFromManifest(source.path),
      manifest: source.manifest,
      launchId: token(),
    })).not.toThrow();

    const held = tmp("retain-live-lock-");
    mkdirSync(held, { recursive: true });
    const child = spawn(process.execPath, [lockFixture, "hold-lock", held], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lock holder did not start")), 8_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (!chunk.includes("\"phase\":\"ready\"")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`lock holder exited ${code}`));
      });
    });
    try {
      expect(() => retainRuntimeGeneration({
        retainDir: held,
        selected: runtimeReferenceFromManifest(source.path),
        manifest: source.manifest,
        launchId: token(),
      })).toThrow(RuntimeRetainError);
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }, 15_000);

  it("keeps a just-published leased T while another process sweeps", async () => {
    const source = packagedFixture("overlap");
    const retainDir = tmp("retain-overlap-");
    const child = spawn(process.execPath, [lockFixture, "sweep-loop", retainDir], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sweeper did not start")), 8_000);
      child.stdout!.setEncoding("utf8");
      let output = "";
      child.stdout!.on("data", (chunk: string) => {
        output += chunk;
        if (!output.includes("\"phase\":\"ready\"")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`sweeper exited ${code}: ${output}`));
      });
    });
    try {
      const result = retainRuntimeGeneration({
        retainDir,
        selected: runtimeReferenceFromManifest(source.path),
        manifest: source.manifest,
        launchId: token(),
        launcherLeaseId: token(),
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(existsSync(result.reference.installRoot)).toBe(true);
      expect(existsSync(join(retainDir, RUNTIME_RETAIN_LEASES_DIR_NAME))).toBe(true);
      expect(existsSync(join(result.reference.installRoot, RUNTIME_RETAINED_MARKER_NAME))).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }, 20_000);
});
