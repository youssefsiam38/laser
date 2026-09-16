import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV } from "@lasercode/protocol";
import { runtimeReferenceFromManifest, writeRuntimeGenerationManifest } from "../src/runtime-generation.js";
import { WorkerClient, type WorkerExit } from "../src/worker-client.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worker(mode: "correct" | "ready-first" | "wrong" | "wrong-feature" | "malformed" | "startup-failure"): { client: WorkerClient; exit: Promise<WorkerExit>; statuses: unknown[] } {
  const root = mkdtempSync(join(tmpdir(), "worker-launch-"));
  roots.push(root);
  const main = join(root, "worker.mjs");
  writeFileSync(main, `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const featureGenerationId = process.env[${JSON.stringify(ENV.featureGenerationId)}];
const send = (status, id = launchId, feature = featureGenerationId) => socket.write(JSON.stringify({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status, launchId: id, mode: "normal", featureGenerationId: feature } }) + "\\n");
if (process.env.MODE === "malformed") socket.write("not-json\\n");
else if (process.env.MODE === "ready-first") send("ready");
else if (process.env.MODE === "wrong") { send("starting", "fedcba9876543210fedcba9876543210"); send("ready"); }
else if (process.env.MODE === "wrong-feature") send("starting", launchId, "b".repeat(64));
else if (process.env.MODE === "startup-failure") {
  send("starting");
  socket.write(JSON.stringify({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "crashed", launchId, mode: "normal", featureGenerationId, failure: { owner: { kind: "worker", launchId, cwd }, stage: "initialize", category: "initialization_error", message: "This project's runtime did not start." } } }) + "\\n", () => process.exit(1));
}
else { send("starting"); send("ready"); }
socket.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const statuses: unknown[] = [];
  let settleExit!: (exit: WorkerExit) => void;
  const exit = new Promise<WorkerExit>((resolve) => { settleExit = resolve; });
  const client = new WorkerClient({
    cwd: root,
    workerMain: main,
    baseEnv: { MODE: mode, PATH: process.env.PATH, [ENV.featureGenerationId]: "a".repeat(64) },
    onNotification: (notification) => statuses.push(notification.params),
    onExit: (_code, _signal, result) => settleExit(result),
  });
  return { client, exit, statuses };
}

describe("worker first-frame launch identity", () => {
  it("accepts starting then ready from the exact child", async () => {
    const { client, statuses } = worker("correct");
    await expect(client.ready).resolves.toBeUndefined();
    expect(statuses).toEqual([
      expect.objectContaining({ status: "starting", launchId: client.launchId, featureGenerationId: "a".repeat(64) }),
      expect.objectContaining({ status: "ready", launchId: client.launchId, featureGenerationId: "a".repeat(64) }),
    ]);
    await client.stop();
  });

  it("delivers a drained structured initialization failure to onExit", async () => {
    const { client, exit } = worker("startup-failure");
    await expect(client.ready).rejects.toThrow(/did not start/i);
    await expect(exit).resolves.toMatchObject({
      kind: "initialization_error",
      failure: { stage: "initialize", category: "initialization_error" },
    });
  });

  it("refuses before spawn when an old host sees its selected worker changed in place", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-generation-drift-"));
    roots.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    const cli = join(root, "app", "cli.js");
    const main = join(root, "app", "worker.js");
    writeFileSync(cli, "cli");
    writeFileSync(main, "worker-one");
    const { path } = writeRuntimeGenerationManifest({
      installRoot: root,
      files: [cli, main],
      entries: { cli: "app/cli.js", worker: "app/worker.js" },
      productVersion: "1.0.0",
      buildIdentity: "old-host",
    });
    const selected = runtimeReferenceFromManifest(path);
    writeFileSync(main, "worker-two");
    expect(() => new WorkerClient({
      cwd: root,
      workerMain: main,
      baseEnv: {
        [ENV.runtimeGenerationId]: selected.generationId,
        [ENV.runtimeInstallRoot]: selected.installRoot,
        [ENV.runtimeManifestDigest]: selected.manifestDigest,
      },
      onNotification: () => undefined,
      onExit: () => undefined,
    })).toThrow(/runtime files changed/i);
  });

  it("categorically refuses a child carrying a different Feature generation", async () => {
    const { client, exit } = worker("wrong-feature");
    await expect(client.ready).rejects.toThrow(/could not verify/i);
    await expect(exit).resolves.toMatchObject({
      kind: "feature_generation_mismatch",
      failure: { category: "feature_generation_mismatch", stage: "announce" },
    });
  });

  it.each([
    ["ready-first", "launch_identity_mismatch"],
    ["wrong", "launch_identity_mismatch"],
    ["malformed", "launch_identity_missing"],
  ] as const)("refuses %s and never resolves readiness", async (mode, category) => {
    const { client, exit } = worker(mode);
    await expect(client.ready).rejects.toThrow(/could not verify/i);
    await expect(exit).resolves.toMatchObject({ kind: category, failure: { category, stage: "announce" } });
  });
});
