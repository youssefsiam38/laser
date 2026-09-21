#!/usr/bin/env node
/**
 * The clean-machine test (M10-T3).
 *
 * laser claims to be self-contained: a person installs it and nothing else,
 * and nothing it runs — not the runtime, not the agent, not the agent's
 * dependencies — comes from their machine. This script is that claim, made
 * checkable.
 *
 * It takes a packaged build and runs it the way a stranger's laptop would:
 * `PATH` pointing at one empty directory, so there is no `node`, no `npm`, no
 * `pnpm` and no agent to fall back on, and a throwaway `HOME` containing a
 * decoy agent directory the app must find, name, and leave completely alone.
 *
 *   pnpm -F @lasercode/desktop run pack
 *   node packages/desktop/scripts/clean-machine.mjs
 *
 *   --dir <path>   a packaged directory other than out/<platform>-unpacked
 *   --json         one JSON object instead of the report
 *
 * Exit status is 0 only if every packaging claim held. Missing credentials are
 * reported and are *not* a failure: a clean machine has none, and that is the
 * user's first-run problem, not a packaging one.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { identity } from "../../../scripts/identity/identity.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// Rows the packaging owns. Anything else doctor reports is about the machine's
// configuration (credentials, a port in use), not about what we shipped.
const PACKAGING_ROWS = new Set([
  "runtime",
  "agent",
  "agent pin",
  "agent loads",
  "agent command",
  "this machine",
  "agent dir",
  "session dir",
  "state dir",
  "subagents root",
]);

const DECOY_SETTINGS = JSON.stringify({ marker: `${identity.name}-clean-machine-decoy` }, null, 2);

function parseArgv(argv) {
  let dir;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--dir") dir = argv[++i];
    else if (argv[i].startsWith("--dir=")) dir = argv[i].slice("--dir=".length);
    else {
      process.stderr.write(`clean-machine: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  return { dir, json };
}

/** Where `electron-builder --dir` puts a build for this platform. */
function defaultPackageDir() {
  const out = join(packageRoot, "out");
  const candidates =
    process.platform === "darwin"
      ? [`mac-${process.arch}`, "mac", "mac-universal"].map((name) => join(out, name, `${identity.displayName}.app`, "Contents"))
      : process.platform === "win32"
        ? [join(out, "win-unpacked")]
        : [join(out, `linux-${process.arch}-unpacked`), join(out, "linux-unpacked")];
  return candidates.find((candidate) => existsSync(join(candidate, "resources"))) ?? candidates[0];
}

const findings = [];
function record(claim, ok, detail, fix) {
  findings.push({ claim, ok, detail, ...(fix && !ok ? { fix } : {}) });
  return ok;
}

/** Every package name under a node_modules, scoped names included. */
function packagesIn(modulesDir) {
  const names = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const child of readdirSync(join(modulesDir, entry.name), { withFileTypes: true })) {
        if (!child.name.startsWith(".")) names.push(`${entry.name}/${child.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

function countSymlinks(root, limit = 200_000) {
  const links = [];
  const stack = [root];
  let seen = 0;
  while (stack.length > 0 && seen < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) stack.push(path);
    }
  }
  return links;
}

function bytesOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function human(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Run a command with an environment that contains only what we put in it. */
function runBare(binary, args, env, timeoutMs = 180_000) {
  try {
    const stdout = execFileSync(binary, args, {
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: typeof error?.status === "number" ? error.status : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? ""),
    };
  }
}

function lastJsonLine(text) {
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // keep looking backwards
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Linux's process table is the packaged gate's exact descendant proof. */
function linuxDescendants(rootPid) {
  if (process.platform !== "linux") return [];
  const children = new Map();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const pid = Number(entry.name);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]);
      const rows = children.get(ppid) ?? [];
      rows.push(pid);
      children.set(ppid, rows);
    } catch {
      // A process can exit while /proc is being walked.
    }
  }
  const found = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (found.includes(pid)) continue;
    found.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return found;
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode, timedOut: false };
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      done({ code: child.exitCode, signal: child.signalCode, timedOut: true });
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, timedOut: false });
    };
    child.once("exit", onExit);
  });
}

const PACKAGED_RPC_PROBE = String.raw`
const { createRequire } = require("node:module");
const WebSocket = createRequire(process.env.PROBE_REQUIRE_FROM)("ws");
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function connect() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const socket = new WebSocket(process.env.PROBE_WS_URL);
    const opened = await new Promise(done => {
      socket.once("open", () => done(true));
      socket.once("error", () => done(false));
    });
    if (opened) return socket;
    socket.close();
    await sleep(100);
  }
  throw new Error("the packaged host did not accept an RPC connection");
}
(async () => {
const socket = await connect();
let nextId = 1;
const pending = new Map();
socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.id === undefined) return;
  const settle = pending.get(message.id);
  if (!settle) return;
  pending.delete(message.id);
  if (message.error) settle.reject(new Error(message.error.message));
  else settle.resolve(message.result);
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 15000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
try {
  const created = await request("session/new", { cwd: process.env.PROBE_PROJECT });
  const listed = await request("pi/model/list", { path: created.state.path });
  const deadline = Date.now() + 60000;
  let proof;
  while (Date.now() < deadline) {
    const answer = await request("resource/snapshot", { refresh: true });
    const rows = answer.snapshot?.pressure?.roles ?? [];
    const host = rows.find(row => row.role === "host");
    const worker = rows.find(row => row.role === "project_worker");
    const hostMeasured = host?.ceiling?.measuredLimit;
    const workerMeasured = worker?.ceiling?.measuredLimit;
    if (host?.ceiling?.configuredBytes === 469762048 && hostMeasured?.status === "available" && hostMeasured.value > 0
      && worker?.coverage?.answered > 0 && worker?.coverage?.complete === true
      && Number.isSafeInteger(worker?.ceiling?.configuredBytes) && worker.ceiling.configuredBytes > 0
      && workerMeasured?.status === "available" && workerMeasured.value > 0) {
      proof = {
        modelCount: listed.models?.length ?? 0,
        hostConfiguredBytes: host.ceiling.configuredBytes,
        hostMeasuredLimit: hostMeasured.value,
        workerConfiguredBytes: worker.ceiling.configuredBytes,
        workerMeasuredLimit: workerMeasured.value,
      };
      break;
    }
    await sleep(1000);
  }
  if (!proof) throw new Error("fresh configured and measured ceiling rows did not arrive");
  console.log(JSON.stringify({ ok: proof.modelCount > 0 && proof.hostConfiguredBytes !== proof.hostMeasuredLimit
    && proof.workerConfiguredBytes !== proof.workerMeasuredLimit, ...proof }));
} finally {
  socket.close();
}
})().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;

// ---------------------------------------------------------------------------

const { dir: dirArg, json } = parseArgv(process.argv.slice(2));
const appDir = resolve(dirArg ?? defaultPackageDir());
const resources = join(appDir, "resources");

if (!existsSync(resources)) {
  process.stderr.write(
    `clean-machine: no packaged build at ${appDir}.\n` +
      `Build one first: pnpm -F @lasercode/desktop run pack\n`,
  );
  process.exit(2);
}

const nodeBinary = join(resources, "runtime", process.platform === "win32" ? "node.exe" : "node");
const modules = join(resources, "app.asar.unpacked", "node_modules");

// 1 ── the runtime is a real, executable file inside the package -------------
record(
  "the runtime is a real file inside the package",
  existsSync(nodeBinary) && lstatSync(nodeBinary).isFile(),
  existsSync(nodeBinary) ? `${nodeBinary} (${human(bytesOf(nodeBinary))})` : `missing: ${nodeBinary}`,
  "electron-builder did not stage the bundled Node. Check packages/desktop/build/before-pack.cjs and runtime.json.",
);

// 2 ── the dependency tree is real files, not links --------------------------
const hasModules = existsSync(modules);
const packageNames = hasModules ? packagesIn(modules) : [];
const symlinks = hasModules ? countSymlinks(modules) : [];
record(
  "the dependency tree is real files, not links",
  hasModules && symlinks.length === 0,
  hasModules
    ? `${packageNames.length} packages, ${symlinks.length} symlinks under ${modules}`
    : `missing: ${modules}`,
  "A packaged tree that contains symlinks points at this machine's node_modules and will not exist on anyone else's. " +
    "Check asarUnpack in electron-builder.yml.",
);

// 3 ── the agent and every workspace package are in it -----------------------
const required = [
  "@earendil-works/pi-coding-agent",
  "@lasercode/cli",
  "@lasercode/host",
  "@lasercode/worker",
  "@lasercode/protocol",
  "@lasercode/pi-extension",
];
const missing = required.filter((name) => !packageNames.includes(name));
record(
  `the agent and every ${identity.name} package are packaged`,
  missing.length === 0,
  missing.length === 0 ? required.join(", ") : `missing: ${missing.join(", ")}`,
  "Declare the missing package as a dependency of a workspace package so the packager copies it, then rebuild.",
);

const coreInstructionsAsset = join(modules, "@lasercode", "worker", "dist", "agents", "core-instructions.md");
record(
  "the worker's shared agent instructions are packaged",
  existsSync(coreInstructionsAsset),
  existsSync(coreInstructionsAsset) ? coreInstructionsAsset : `missing: ${coreInstructionsAsset}`,
  "Preserve the worker's executable Markdown prompt asset in electron-builder.yml, then rebuild.",
);

const legalFiles = ["LICENSE", "LICENSING.md", "COMMERCIAL.md", "TRADEMARKS.md"];
const missingLegal = legalFiles.filter((name) => !existsSync(join(resources, "legal", name)));
record(
  "the distribution carries its license and brand terms",
  missingLegal.length === 0,
  missingLegal.length === 0 ? legalFiles.join(", ") : `missing: ${missingLegal.join(", ")}`,
  "Stage the repository's legal files under resources/legal and rebuild.",
);

// 4 ── a bare environment: no node, npm, pnpm or agent anywhere on PATH ------
const sandbox = mkdtempSync(join(tmpdir(), `${identity.name}-clean-`));
const emptyBin = join(sandbox, "bin");
const fakeHome = join(sandbox, "home");
const scratchAgent = join(sandbox, identity.dirName, "agent");
const scratchSessions = join(sandbox, identity.dirName, "sessions");
const scratchState = join(sandbox, identity.dirName, "state");
const scratchProject = join(sandbox, "project");
const decoyAgentDir = join(fakeHome, ".pi", "agent");
for (const directory of [emptyBin, decoyAgentDir, scratchAgent, scratchSessions, scratchState, scratchProject]) {
  mkdirSync(directory, { recursive: true });
}
writeFileSync(join(scratchAgent, "models.json"), JSON.stringify({ providers: {
  packaged: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "offline", models: [
    { id: "packaged", name: "Packaged", contextWindow: 8192, maxTokens: 256 },
  ] },
} }));
writeFileSync(join(scratchAgent, "settings.json"), JSON.stringify({
  // A packaged app starts on a profile, never on a raw default model
  // (docs/model-profiles.md): the settings a fresh install would hold after
  // the profile review step.
  modelProfiles: [{ id: "mp_packagedbalanced", name: "Balanced", models: [{ provider: "packaged", id: "packaged" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" }],
  defaultProfileId: "mp_packagedbalanced", namingProfileId: "mp_packagedbalanced",
  enabledModels: ["packaged/packaged"],
}));
const decoyPath = join(decoyAgentDir, "settings.json");
writeFileSync(decoyPath, DECOY_SETTINGS);
const decoyBefore = statSync(decoyPath);

const packagedRuntime = JSON.parse(readFileSync(join(resources, "native-update-template.json"), "utf8"));
const bareEnv = {
  PATH: emptyBin,
  HOME: fakeHome,
  // Named explicitly so this run cannot land in the real one, and so the
  // decoy above is the only agent directory anywhere near it.
  [identity.env.agentDir]: scratchAgent,
  [identity.env.sessionDir]: scratchSessions,
  [identity.env.stateDir]: scratchState,
  [identity.env.runtimeGenerationId]: packagedRuntime.generationId,
  [identity.env.runtimeInstallRoot]: appDir,
  [identity.env.runtimeManifestDigest]: packagedRuntime.manifestDigest,
  // A port nothing else is on, so "the port is busy" cannot masquerade as a
  // packaging failure.
  [identity.env.port]: "47311",
};
const reachable = ["node", "npm", "pnpm", "pi"].filter((name) => existsSync(join(emptyBin, name)));
record(
  "PATH has no node, npm, pnpm or agent on it",
  reachable.length === 0,
  `PATH=${emptyBin} (empty), HOME=${fakeHome}`,
  "The sandbox was not empty; this run proves nothing.",
);

// 5 ── the bundled Node runs, and says it is plain Node ----------------------
const probe = runBare(nodeBinary, ["-p", "JSON.stringify({v:process.version,e:process.execPath,el:!!process.versions.electron})"], bareEnv, 30_000);
const probed = lastJsonLine(probe.stdout);
record(
  "the bundled runtime runs with nothing on PATH",
  Boolean(probed) && probed.el === false && probed.e === nodeBinary,
  probed ? `node ${probed.v}, process.execPath = ${probed.e}` : `it did not answer: ${probe.stderr.trim() || "no output"}`,
  "The shipped binary is not a usable plain Node. Re-stage it: pnpm -F @lasercode/desktop runtime -- --current.",
);

// 5a ── the desktop's own launch preflight accepts its install ---------------
//
// The host verifies the runtime inventory under bundled Node, but the desktop
// runs the same verification first, inside Electron, whose fs presents
// `app.asar` as a directory. 0.7.0 shipped with that preflight refusing every
// install ("runtime files changed"). This runs the packaged preflight module
// in the packaged Electron, against scratch data, exactly as startup does.
const electronBinary = process.platform === "darwin"
  ? join(appDir, "MacOS", identity.displayName)
  : process.platform === "win32"
    ? join(appDir, `${identity.displayName}.exe`)
    : join(appDir, identity.realBinary);
const preflightProbe = join(sandbox, "preflight-probe.mjs");
writeFileSync(preflightProbe, `
import { pathToFileURL } from "node:url";
const [resources, scratch] = process.argv.slice(2);
const { prepareInstalledRuntimeOffMain } = await import(pathToFileURL(resources + "/app.asar/dist/migration-preflight.js").href);
const paths = { agentDir: scratch + "/agent", sessionDir: scratch + "/sessions", stateDir: scratch + "/state",
  hostFile: scratch + "/state/host.json", logFile: scratch + "/state/host.log", host: "127.0.0.1", port: 9 };
try {
  await prepareInstalledRuntimeOffMain(paths, ${JSON.stringify(join(modules, "@lasercode", "cli", "dist", "main.js"))});
  console.log(JSON.stringify({ ok: true, electron: process.versions.electron }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, electron: process.versions.electron, error: error instanceof Error ? error.message : String(error) }));
}
`);
const preflightScratch = join(sandbox, "preflight");
for (const name of ["agent", "sessions", "state"]) mkdirSync(join(preflightScratch, name), { recursive: true });
const preflightRun = existsSync(electronBinary)
  ? runBare(electronBinary, [preflightProbe, resources, preflightScratch], { ...bareEnv, ELECTRON_RUN_AS_NODE: "1" }, 120_000)
  : { code: 1, stdout: "", stderr: `missing: ${electronBinary}` };
const preflight = lastJsonLine(preflightRun.stdout);
record(
  "the desktop's launch preflight verifies this install inside Electron",
  Boolean(preflight?.ok) && Boolean(preflight.electron),
  preflight?.ok
    ? `Electron ${preflight.electron} accepted runtime generation ${String(packagedRuntime.generationId).slice(0, 12)}…`
    : preflight?.error ?? (preflightRun.stderr.trim() || "no answer"),
  "Electron's asar-aware fs must not read the runtime inventory. Check packages/host/src/runtime-generation.ts uses original-fs under Electron.",
);

// 6 ── the agent resolves from inside the package, and all of it loads -------
const resolver = join(modules, "@lasercode", "worker", "dist", "resolve-pi.js");
const agentRun = runBare(nodeBinary, [resolver, "--check"], bareEnv);
const agentReport = lastJsonLine(agentRun.stdout);
const insidePackage = (path) => typeof path === "string" && path.startsWith(`${appDir}${sep}`);
record(
  "the agent resolves from inside the package and its whole graph loads",
  Boolean(agentReport?.ok) && insidePackage(agentReport.agent.packageDir),
  agentReport?.ok
    ? `${agentReport.agent.package} ${agentReport.agent.version} (pinned ${agentReport.agent.pinned}) ` +
      `at ${agentReport.agent.packageDir}, loaded in ${agentReport.agent.loadMs}ms`
    : agentReport?.error ?? agentRun.stderr.trim() ?? "no answer",
  agentReport?.fix ?? "Rebuild the package and check that the agent's whole dependency tree is declared.",
);
record(
  "the agent on disk is the version pinned in git",
  Boolean(agentReport?.ok) && agentReport.agent.version === agentReport.agent.pinned,
  agentReport?.ok ? `${agentReport.agent.version} === ${agentReport.agent.pinned}` : "could not be read",
  "Reinstall the dependencies and rebuild the package.",
);

// Lazy MCP helpers/native code are not all reached by a stdio-only session.
// Resolve them from the adapter, not the desktop (which uses keyring 2.x).
const mcpArtifactRun = runBare(nodeBinary, [
  join(packageRoot, "scripts", "check-mcp-artifact.mjs"),
  join(modules, "@lasercode", "worker", "package.json"), modules,
], bareEnv);
const mcpArtifact = lastJsonLine(mcpArtifactRun.stdout);
record(
  "MCP executable assets and native bindings are packaged",
  mcpArtifactRun.code === 0 && Boolean(mcpArtifact?.ok),
  mcpArtifact?.ok
    ? `${mcpArtifact.assets} assets, ${mcpArtifact.skills} skill; keyring ${mcpArtifact.keyringVersion} and filesystem prebuild load; jiti, TOML and both MCP SDK packages resolve inside the build`
    : mcpArtifact?.error ?? mcpArtifactRun.stderr.trim() ?? "no answer",
  "Preserve the adapter's published files, skills and native prebuilds; verify its own keyring version and platform binding, not the desktop's.",
);

// 6a ── the ReDoS guard still answers, on every backend we ship -----------
//
// The MCP adapter refuses a regex search whose pattern it cannot prove safe,
// and it proves it with `checkSync` (proxy-modes.ts). That call runs either in
// a synckit worker — which prefers the native `recheck-<os>-<arch>` binary,
// then a JVM archive, then the library's own pure-JS engine — or, with
// RECHECK_SYNC_BACKEND=pure, in that pure engine directly. We ship the native
// binary where one exists and never the 22 MB archive, so on a target with no
// published binary (both arm64 ones) the pure engine is the only backend left.
// This asks the default backend and the pure engine the same three questions
// and requires the same three answers from both, so a packaging change that
// leaves the guard unable to answer — which would reject every regex search a
// person makes — fails the gate here instead of on their machine. The analysis
// budget is generous on purpose: what is being checked is that the engine is
// there and answers, not how fast it answers, and an emulated arm64 runner has
// returned `unknown` at 253 ms against a 250 ms budget.
const REDOS_CASES = [
  { source: "^(a|a)*$", expect: "vulnerable" },
  { source: "get_.*_tool", expect: "vulnerable" },
  { source: "^[a-z]+(foo|bar)?$", expect: "safe" },
];
const redosScript =
  `const { createRequire } = require("node:module");` +
  `const req = createRequire(${JSON.stringify(join(modules, "clean-machine-probe.cjs"))});` +
  `const { checkSync } = req("recheck");` +
  `const cases = ${JSON.stringify(REDOS_CASES)};` +
  `const out = [];` +
  `for (const c of cases) { const t = Date.now(); const r = checkSync(c.source, "i", { attackTimeout: 1000, incubationTimeout: 1000, timeout: 10000 });` +
  ` out.push({ source: c.source, expect: c.expect, status: r.status, ms: Date.now() - t }); }` +
  `console.log(JSON.stringify({ backend: process.env.RECHECK_SYNC_BACKEND || "default", results: out }));`;
const redosRuns = [
  runBare(nodeBinary, ["-e", redosScript], bareEnv, 60_000),
  runBare(nodeBinary, ["-e", redosScript], { ...bareEnv, RECHECK_SYNC_BACKEND: "pure" }, 60_000),
].map((run) => lastJsonLine(run.stdout) ?? { backend: "?", results: [], error: run.stderr.trim() || "no answer" });
const redosOk = redosRuns.every(
  (run) => run.results.length === REDOS_CASES.length && run.results.every((row) => row.status === row.expect),
);
// The archive must be gone (that is the exclusion this check defends) and the
// engine that answers when nothing else can must be present.
const redosJarPresent = existsSync(join(modules, "recheck-jar"));
const redosPureEngine = existsSync(join(modules, "recheck", "lib", "main.js"));
const redosNative = packageNames.filter((name) => name.startsWith("recheck-") && name !== "recheck-jar");
record(
  "the regex safety guard answers the same on every backend the package ships",
  redosOk && !redosJarPresent && redosPureEngine,
  [
    ...redosRuns.map((run) =>
      run.results.length > 0
        ? `${run.backend}: ${run.results.map((row) => `${row.status}${row.status === row.expect ? "" : ` (expected ${row.expect})`} in ${row.ms}ms`).join(", ")}`
        : `${run.backend}: ${run.error ?? "no answer"}`,
    ),
    `native binding: ${redosNative.join(", ") || "none published for this platform"}`,
    `JVM archive: ${redosJarPresent ? "present (it should not be)" : "absent"}`,
  ].join("; "),
  "The MCP adapter's regex search rejects every pattern it cannot prove safe. Keep the checker's native binary and its " +
    "pure-JS engine in the package (electron-builder.yml excludes only the JVM archive).",
);

// 7 ── a real session loads every bundled feature --------------------------
const cli = join(modules, "@lasercode", "cli", "dist", "main.js");
const sessionProbe = join(modules, "@lasercode", "worker", "dist", "check-packaged-session.js");
const mcpFixture = join(resources, "checks", "mcp-server.mjs");
const sessionRun = runBare(nodeBinary, [sessionProbe, mcpFixture], {
  ...bareEnv,
  [identity.env.npmCli]: join(resources, "runtime", "npm", "bin", "npm-cli.js"),
});
const sessionReport = lastJsonLine(sessionRun.stdout);
record(
  "a real session opens with every bundled feature",
  Boolean(sessionReport?.ok) && sessionReport.modelCount > 0,
  sessionReport?.ok
    ? `session ${sessionReport.sessionId}; ${sessionReport.modelCount} models available to the picker`
    : sessionReport?.error ?? sessionRun.stderr.trim() ?? "no answer",
  "The packaged worker could not load a curated feature. Preserve executable dependency source and rebuild.",
);

// 7a ── the agent harness is active in that session (M13-T9) ----------------
//
// The harness is Laser's own: the `subagents` module registers `start_agent`
// and its siblings from the worker's bridge, `background-work` owns long
// commands. Neither reads a package off disk, so "the package is present" is
// no evidence; only the session report's active module list is.
const HARNESS_MODULES = ["subagents", "background-work"];
const activeModules = Array.isArray(sessionReport?.modules) ? sessionReport.modules.filter((name) => typeof name === "string") : [];
const missingModules = HARNESS_MODULES.filter((name) => !activeModules.includes(name));
record(
  "the agent harness modules are active in that session",
  Boolean(sessionReport?.ok) && missingModules.length === 0,
  sessionReport?.ok
    ? missingModules.length === 0
      ? `active: ${activeModules.join(", ")}`
      : `missing: ${missingModules.join(", ")}; active: ${activeModules.join(", ") || "none"}`
    : "the session did not open",
  "The companion extension did not activate the harness. Check that the packaged worker builds the agents bridge for every session and that the extension's modules are bundled whole.",
);

record(
  "MCP stdio tools reach the model and the inspector",
  Boolean(sessionReport?.ok) && activeModules.includes("mcp") &&
    sessionReport.mcp?.modelTool === "packaged_runtime" && sessionReport.mcp?.inspectedTool === "packaged_runtime" &&
    sessionReport.mcp?.runtime === nodeBinary && /^\d+\.\d+\.\d+/.test(sessionReport.mcp?.npxVersion ?? ""),
  sessionReport?.mcp
    ? `model: ${sessionReport.mcp.modelTool}; inspect/call: ${sessionReport.mcp.inspectedTool}; child: ${sessionReport.mcp.runtime}; npx: ${sessionReport.mcp.npxVersion}`
    : "the offline MCP probe did not complete",
  "Preserve the adapter's executable sources and dependencies; stdio must resolve node through the worker's bundled-runtime PATH additions.",
);

// 7b ── the packaged daemon and worker keep their launch ceilings -----------
let packagedHostReport;
let packagedHostFailure;
let packagedHostGraceful = false;
let packagedHostSurvivors = [];
const packagedHostPort = await freePort();
const packagedHost = spawn(nodeBinary, [
  "--max-old-space-size=448",
  cli,
  "__daemon",
  "--port",
  String(packagedHostPort),
  "--agent-dir",
  scratchAgent,
  "--session-dir",
  scratchSessions,
  "--state-dir",
  scratchState,
], {
  cwd: scratchState,
  env: { ...bareEnv, [identity.env.hostLaunchId]: randomBytes(16).toString("hex") },
  stdio: ["ignore", "ignore", "ignore"],
});
packagedHost.once("error", (error) => { packagedHostFailure = error.message; });
try {
  const run = runBare(nodeBinary, ["-e", PACKAGED_RPC_PROBE], {
    ...bareEnv,
    PROBE_REQUIRE_FROM: join(modules, "clean-machine-rpc.cjs"),
    PROBE_WS_URL: `ws://127.0.0.1:${packagedHostPort}/ws`,
    PROBE_PROJECT: scratchProject,
  }, 90_000);
  packagedHostReport = lastJsonLine(run.stdout);
  if (!packagedHostReport?.ok) packagedHostFailure = run.stderr.trim() || "the packaged RPC probe did not prove its claims";
} finally {
  const descendants = packagedHost.pid ? linuxDescendants(packagedHost.pid) : [];
  packagedHost.kill("SIGTERM");
  let exit = await waitForChildExit(packagedHost, 20_000);
  if (exit.timedOut) {
    packagedHost.kill("SIGKILL");
    exit = await waitForChildExit(packagedHost, 5_000);
  }
  packagedHostGraceful = !exit.timedOut && exit.code === 0 && exit.signal === null;
  for (let attempt = 0; attempt < 100 && descendants.some(processAlive); attempt += 1) await sleep(50);
  packagedHostSurvivors = descendants.filter(processAlive);
  for (const pid of packagedHostSurvivors) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}
record(
  "the packaged daemon and worker enforce distinct configured and measured heap ceilings",
  Boolean(packagedHostReport?.ok) && packagedHostReport.modelCount > 0 && packagedHostGraceful && packagedHostSurvivors.length === 0
    && !Object.hasOwn(bareEnv, "NODE_OPTIONS"),
  packagedHostReport?.ok
    ? `${packagedHostReport.modelCount} model(s); host configured ${human(packagedHostReport.hostConfiguredBytes)}, measured ${human(packagedHostReport.hostMeasuredLimit)}; ` +
      `worker configured ${human(packagedHostReport.workerConfiguredBytes)}, measured ${human(packagedHostReport.workerMeasuredLimit)}; ` +
      `SIGTERM clean=${packagedHostGraceful}; survivors=${packagedHostSurvivors.length}`
    : packagedHostFailure ?? "the packaged host did not answer",
  "Run the packaged CLI daemon with the bundled Node, preserve its explicit old-space argv, and wait for one fresh worker pressure report.",
);

// 8 ── the machine's own agent is found and not used ------------------------
record(
  "an agent directory on the machine is seen and not used",
  Boolean(agentReport?.ok) &&
    agentReport.machine?.homeAgentDir === decoyAgentDir &&
    !insidePackage(decoyAgentDir),
  agentReport?.ok
    ? `found ${agentReport.machine?.homeAgentDir ?? "nothing"}; the agent used is ${agentReport.agent.packageDir}`
    : "could not be read",
  "The resolver should notice another installation and still resolve inside the package.",
);

// 9 ── doctor, from inside the package, with nothing on PATH ----------------
const doctorRun = runBare(nodeBinary, [cli, "doctor", "--skip-worker", "--json", "--no-color"], bareEnv);
const doctorReport = lastJsonLine(doctorRun.stdout);
const rows = doctorReport?.checks ?? [];
const packagingFailures = rows.filter((row) => PACKAGING_ROWS.has(row.name) && row.status === "fail");
record(
  "doctor's packaging checks all pass with nothing on PATH",
  rows.length > 0 && packagingFailures.length === 0,
  rows.length === 0
    ? `doctor gave no answer: ${doctorRun.stderr.trim() || doctorRun.stdout.trim() || "no output"}`
    : `${rows.filter((row) => PACKAGING_ROWS.has(row.name) && row.status === "pass").length} of ` +
      `${rows.filter((row) => PACKAGING_ROWS.has(row.name)).length} packaging rows passed`,
  packagingFailures.map((row) => `${row.name}: ${row.detail}`).join("; ") || "Run doctor by hand inside the package.",
);

// 10 ── nothing wrote to the machine's own agent directory ------------------
const decoyAfter = existsSync(decoyPath) ? statSync(decoyPath) : undefined;
record(
  "the machine's own agent directory was not written to",
  Boolean(decoyAfter) &&
    readFileSync(decoyPath, "utf8") === DECOY_SETTINGS &&
    decoyAfter.mtimeMs === decoyBefore.mtimeMs &&
    readdirSync(decoyAgentDir).length === 1,
  decoyAfter
    ? `${decoyPath} unchanged; ${readdirSync(decoyAgentDir).length} file(s) in that directory`
    : `${decoyPath} was deleted`,
  `Something in ${identity.name} wrote to another installation's agent directory. That is a bug, not a warning.`,
);

// ---------------------------------------------------------------------- out

const environmentRows = rows.filter((row) => !PACKAGING_ROWS.has(row.name));
const ok = findings.every((finding) => finding.ok);

if (json) {
  process.stdout.write(
    `${JSON.stringify({ ok, packageDir: appDir, findings, agent: agentReport ?? null, doctor: doctorReport ?? null }, null, 2)}\n`,
  );
} else {
  const pad = Math.max(...findings.map((finding) => finding.claim.length));
  process.stdout.write(`\nclean machine · ${appDir}\n\n`);
  for (const finding of findings) {
    process.stdout.write(`  ${finding.ok ? "YES" : "NO "}  ${finding.claim.padEnd(pad)}  ${finding.detail}\n`);
    if (finding.fix) process.stdout.write(`       ${" ".repeat(pad)}  -> ${finding.fix}\n`);
  }
  if (environmentRows.length > 0) {
    process.stdout.write(`\n  Not about packaging — this machine's own configuration:\n`);
    for (const row of environmentRows) {
      process.stdout.write(`    ${row.status.toUpperCase().padEnd(4)} ${row.name}: ${row.detail}\n`);
    }
  }
  process.stdout.write(
    `\n  ${ok ? "Every packaging claim held." : `${findings.filter((f) => !f.ok).length} claim(s) failed.`}\n\n`,
  );
}

rmSync(sandbox, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
