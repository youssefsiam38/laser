import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { identity, repoRoot } from "../../../scripts/identity/identity.mjs";

const checkout = repoRoot;
const packageVersion = JSON.parse(readFileSync(join(checkout, "packages/desktop/package.json"), "utf8")).version;
const deb = join(checkout, `packages/desktop/out/${identity.binary}_${packageVersion}_amd64.deb`);
const scratch = mkdtempSync(join(tmpdir(), `${identity.name}-migration-deb-cycle-`));
const fixedRoot = join(scratch, "root");
execFileSync("dpkg-deb", ["-x", deb, fixedRoot]);
const install = join(fixedRoot, "opt", identity.displayName);
const api = await import(pathToFileURL(join(checkout, "packages/host/dist/index.js")));
const manifestPath = join(install, "runtime-manifest.json");
const shipped = JSON.parse(readFileSync(manifestPath, "utf8"));
const files = shipped.inventory.map((row) => join(install, row.path));
const cli = join(install, shipped.entries.cli);
const node = join(install, shipped.entries.node);
const packageScope = dirname(dirname(dirname(cli)));
const registry = join(packageScope, "host", "dist/migrations/registry.js");
const originalCli = readFileSync(cli);
writeFileSync(cli, Buffer.concat([originalCli, Buffer.from("\n// prior installed generation\n")]));
const prior = api.writeRuntimeGenerationManifest({
  installRoot: install, files, entries: shipped.entries, productVersion: "0.6.3", buildIdentity: "migration-prior-fixture",
});
const priorRef = api.runtimeReferenceFromManifest(prior.path);

const paths = (name, port) => {
  const base = join(scratch, name);
  const stateDir = join(base, "state");
  const agentDir = join(base, "agent");
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  return {
    stateDir, agentDir, sessionDir, hostFile: join(stateDir, "host.json"), logFile: join(stateDir, "host.log"),
    host: "127.0.0.1", port, portIsExplicit: true,
  };
};
const freePort = async () => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});
const successPaths = paths("success", await freePort());
const rollbackPaths = paths("rollback", await freePort());
api.prepareRuntimeGeneration(successPaths.stateDir, cli);
api.prepareRuntimeGeneration(rollbackPaths.stateDir, cli);
writeFileSync(join(successPaths.stateDir, "fixture.txt"), "before\n", { mode: 0o600 });
writeFileSync(join(successPaths.stateDir, "second.txt"), "before-second\n", { mode: 0o640 });
writeFileSync(join(rollbackPaths.stateDir, "fixture.txt"), "fail-before\n", { mode: 0o600 });
writeFileSync(join(rollbackPaths.stateDir, "second.txt"), "fail-second\n", { mode: 0o640 });

// The package manager overwrites the same fixed root. A synthetic staged-generation
// registry exercises the shipped framework without inventing a production rewrite.
execFileSync("dpkg-deb", ["-x", deb, fixedRoot]);
writeFileSync(registry, `const first = { root: "stateDir", path: "fixture.txt", type: "file" };\nconst second = { root: "stateDir", path: "second.txt", type: "file" };\nexport const MIGRATION_REGISTRY = { targetSchema: 2, steps: [{ id: "synthetic-v2", fromSchema: 1, toSchema: 2, units: [first, second], run(context) { const before = context.readFile(first).toString("utf8"); context.writeFile(first, "after\\n", 416); context.writeFile(second, "after-second\\n", 416); if (before.startsWith("fail")) throw new Error("synthetic package failure"); } }] };\n`);
const current = api.writeRuntimeGenerationManifest({
  installRoot: install, files, entries: shipped.entries, productVersion: shipped.productVersion, buildIdentity: "migration-target-fixture",
});
const updateId = api.runtimeUpdateId(current.manifest);
const cliApi = await import(pathToFileURL(join(packageScope, "cli", "dist/index.js")));
const runCli = (args, p) => spawnSync(node, [cli, ...args, "--state-dir", p.stateDir, "--agent-dir", p.agentDir, "--session-dir", p.sessionDir, "--port", String(p.port)], {
  env: { PATH: "", HOME: join(scratch, "home"), XDG_DATA_HOME: join(scratch, "xdg") }, encoding: "utf8", timeout: 60_000,
});
const stop = (p) => runCli(["down"], p);
const jsonl = (file) => readFileSync(file, "utf8").split("\n").flatMap((line) => {
  if (!line.startsWith("{")) return [];
  try { return [JSON.parse(line)]; } catch { return []; }
});

const success = runCli(["up"], successPaths);
if (success.status !== 0) throw new Error(`packaged success launch failed: ${success.stdout}\n${success.stderr}`);
const successTx = new api.UpdateTransactionStore(successPaths.stateDir).read(updateId);
if (successTx?.phase !== "succeeded" || readFileSync(join(successPaths.stateDir, "fixture.txt"), "utf8") !== "after\n") {
  throw new Error(`packaged success was not migrated and committed: ${JSON.stringify(successTx)}`);
}
if (existsSync(join(successPaths.stateDir, "migration-snapshots", updateId))) throw new Error("healthy launch retained migration snapshot");
const successEvents = jsonl(successPaths.logFile);
const stoppedSuccess = stop(successPaths);
if (stoppedSuccess.status !== 0) throw new Error(`could not stop success host: ${stoppedSuccess.stderr}`);

const failed = runCli(["up"], rollbackPaths);
if (failed.status === 0) throw new Error("failing synthetic migration started a host");
const failedTx = new api.UpdateTransactionStore(rollbackPaths.stateDir).read(updateId);
if (failedTx?.phase !== "failed" || existsSync(rollbackPaths.hostFile)) throw new Error("failed migration bound a host or lost its transaction");
const log = readFileSync(rollbackPaths.logFile, "utf8");
const events = jsonl(rollbackPaths.logFile);
if (!events.some((event) => event.schemaVersion === 1 && event.type === "migration" && event.updateId === updateId && event.phase === "failed")) {
  throw new Error("packaged failure did not emit correlated JSONL");
}
if (log.includes(scratch) || log.includes("fail-before")) throw new Error("migration JSONL leaked a path or content");
cliApi.restoreUpdateData(rollbackPaths, updateId);
if (readFileSync(join(rollbackPaths.stateDir, "fixture.txt"), "utf8") !== "fail-before\n"
  || readFileSync(join(rollbackPaths.stateDir, "second.txt"), "utf8") !== "fail-second\n"
  || (statSync(join(rollbackPaths.stateDir, "fixture.txt")).mode & 0o777) !== 0o600
  || (statSync(join(rollbackPaths.stateDir, "second.txt")).mode & 0o777) !== 0o640) {
  throw new Error("packaged rollback did not restore exact bytes and modes");
}
if (new api.UpdateTransactionStore(rollbackPaths.stateDir).read(updateId)?.phase !== "rolled_back") throw new Error("rollback phase was not durable");
writeFileSync(join(rollbackPaths.stateDir, "fixture.txt"), "retry-before\n", { mode: 0o600 });
const retry = runCli(["up"], rollbackPaths);
if (retry.status !== 0) throw new Error(`packaged retry failed: ${retry.stdout}\n${retry.stderr}`);
const retryTx = new api.UpdateTransactionStore(rollbackPaths.stateDir).read(updateId);
if (retryTx?.phase !== "succeeded" || readFileSync(join(rollbackPaths.stateDir, "fixture.txt"), "utf8") !== "after\n") {
  throw new Error("packaged retry did not activate after rollback");
}
const stoppedRetry = stop(rollbackPaths);
if (stoppedRetry.status !== 0) throw new Error(`could not stop retry host: ${stoppedRetry.stderr}`);

console.log(JSON.stringify({
  deb,
  fixedRoot: `/tmp/<redacted>/root/opt/${identity.displayName}`,
  priorGeneration: priorRef.generationId,
  targetGeneration: current.manifest.generationId,
  updateId,
  success: {
    phase: successTx.phase, launchIdLength: successTx.selectedLaunchId?.length, data: "migrated", snapshotRemoved: true,
    jsonl: successEvents,
  },
  failure: { phase: failedTx.phase, hostBound: false, jsonl: events },
  rollback: { bytesAndModes: "exact", phase: "rolled_back" },
  retry: { phase: retryTx.phase, data: "migrated" },
}, null, 2));
