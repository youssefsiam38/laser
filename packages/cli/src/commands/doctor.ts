/**
 * `piorbit doctor` — the command that has to earn trust.
 *
 * Every check answers a question a broken setup actually raises, in the order a
 * failure would cascade: the runtime, the bundled agent, the directories, the
 * credentials, the port, the subagent roots, and finally a real worker with a
 * real session, which is the only check that proves the whole chain.
 *
 * The first two rows exist to make one claim checkable rather than marketing:
 * **nothing piorbit runs comes from this machine.** The runtime is the Node
 * binary shipped inside the application; the agent is the exact version pinned
 * in git, resolved from inside the package. If a person has their own agent
 * installed, doctor finds it, names it, and says it is not being used.
 *
 * Rules this file keeps:
 *   - no check ever prints a secret; credentials are reported by provider name,
 *     type and expiry only;
 *   - every non-PASS row carries a fix that is a command or a decision, not
 *     "check your configuration";
 *   - a check that cannot run says so (SKIP) instead of passing quietly.
 */
import { ENV, PRODUCT_NAME } from "@piorbit/protocol";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerClient } from "@piorbit/host";
import type { ModelRef, SessionState } from "@piorbit/protocol";
import { bool } from "../args.js";
import type { Command } from "../command.js";
import { hostUrl, type PiorbitPaths } from "../config.js";
import { ExitCode, messageOf } from "../errors.js";
import { inspectHost, portInUse, probeHealth } from "../hostfile.js";
import type { Painter, Terminal } from "../output.js";
import { runPi } from "../pi.js";
import { formatDuration } from "../render.js";

type Status = "pass" | "warn" | "fail" | "skip";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
  data?: Record<string, unknown>;
}

const MIN_NODE_MAJOR = 24;
const LOW_DISK_BYTES = 1024 * 1024 * 1024; // 1 GiB

export const doctorCommand: Command = {
  name: "doctor",
  group: "Diagnostics",
  summary: `check that ${PRODUCT_NAME} can actually work, and say how to fix what cannot`,
  usage: `${PRODUCT_NAME} doctor [--skip-worker] [--timeout <seconds>]`,
  description: `
Checks the runtime ${PRODUCT_NAME} ships, the agent ${PRODUCT_NAME} ships (that it is there,
that it is the pinned version, and that the whole of it loads), the agent,
session and state directories, provider credentials (names only — never a
secret), the host port, the subagent temp roots, and finally spawns a throwaway
worker in a temporary directory and opens a session in it.

It also says whether this machine has an agent of its own — and that ${PRODUCT_NAME} is
not using it.

Exits 1 if any check FAILs, 0 if the worst is a WARN, so it is safe in CI.
`,
  flags: {
    "skip-worker": {
      type: "boolean",
      description: "Skip the worker smoke test (the slow check; it starts a real Pi session)",
    },
    timeout: { type: "number", description: "Seconds to allow each spawned process", placeholder: "<seconds>", default: 60 },
  },
  examples: [
    { note: "the usual", command: `${PRODUCT_NAME} doctor` },
    { note: "fast checks only", command: `${PRODUCT_NAME} doctor --skip-worker` },
    { note: "in CI", command: `${PRODUCT_NAME} doctor --json --no-color` },
  ],
  async run({ term, paths, args }) {
    const timeoutMs = Math.max(1, args.flags["timeout"] === undefined ? 60 : Number(args.flags["timeout"])) * 1000;
    const checks: Check[] = [];

    // One child process answers for the runtime and the agent together: it is
    // the *bundled* Node resolving the agent from the *worker's* own directory,
    // which is the only place the answer means anything.
    const agent = await inspectBundledAgent(timeoutMs);
    checks.push(checkRuntime());
    checks.push(...agentChecks(agent));
    if (agent.ok) checks.push(await checkAgentCommand(paths, timeoutMs));
    checks.push(checkMachineAgent(agent, paths));
    checks.push(...agentDirChecks(paths));
    checks.push(checkWritableDir("session dir", paths.sessionDir, true, "--session-dir"));
    checks.push(checkWritableDir("state dir", paths.stateDir, true, "--state-dir"));
    checks.push(checkProviders(paths));
    checks.push(await checkPort(paths));
    checks.push(...(await checkSubagentRoots(paths)));

    if (bool(args, "skip-worker")) {
      checks.push({
        name: "worker",
        status: "skip",
        detail: "skipped (--skip-worker)",
        fix: `Run \`${PRODUCT_NAME} doctor\` without --skip-worker to prove a session really opens.`,
      });
      checks.push({ name: "default model", status: "skip", detail: "needs the worker check" });
      checks.push({ name: "model auth", status: "skip", detail: "needs the worker check" });
    } else if (!agent.ok) {
      checks.push({
        name: "worker",
        status: "skip",
        detail: `skipped: the agent ${PRODUCT_NAME} ships did not resolve`,
        fix: "Fix the agent first; this check cannot run without it.",
      });
      checks.push({ name: "default model", status: "skip", detail: "needs the worker check" });
      checks.push({ name: "model auth", status: "skip", detail: "needs the worker check" });
    } else {
      const worker = await checkWorker(paths, timeoutMs);
      checks.push(worker.check, worker.model, worker.auth);
    }

    const failed = checks.filter((check) => check.status === "fail").length;
    const warned = checks.filter((check) => check.status === "warn").length;

    if (term.json) {
      term.data({
        ok: failed === 0,
        summary: {
          pass: checks.filter((check) => check.status === "pass").length,
          warn: warned,
          fail: failed,
          skip: checks.filter((check) => check.status === "skip").length,
        },
        bundled: agent.ok
          ? { runtime: agent.report.runtime, agent: agent.report.agent, machine: agent.report.machine }
          : { runtime: { execPath: process.execPath, version: process.version }, error: agent.error },
        paths: {
          agentDir: paths.agentDir,
          sessionDir: paths.sessionDir,
          stateDir: paths.stateDir,
          subagentsTempRoot: paths.subagentsTempRoot,
          port: paths.port,
        },
        checks,
      });
      return failed === 0 ? ExitCode.Ok : ExitCode.Failure;
    }

    render(term, checks);
    term.note();
    const summary = [
      `${checks.filter((check) => check.status === "pass").length} passed`,
      warned > 0 ? term.err.yellow(`${warned} warning${warned === 1 ? "" : "s"}`) : "",
      failed > 0 ? term.err.red(`${failed} failed`) : "",
    ]
      .filter(Boolean)
      .join(", ");
    term.note(summary);
    if (failed === 0 && warned === 0) term.note(term.err.dim(`${PRODUCT_NAME} is ready. \`${PRODUCT_NAME} up\` starts the app.`));
    return failed === 0 ? ExitCode.Ok : ExitCode.Failure;
  },
};

function render(term: Terminal, checks: readonly Check[]): void {
  const p = term.out;
  const pad = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    term.print(`  ${badge(check.status, p)}  ${check.name.padEnd(pad)}  ${check.detail}`);
    if (check.fix && check.status !== "pass") term.print(`        ${" ".repeat(pad)}  ${p.dim(`→ ${check.fix}`)}`);
  }
}

function badge(status: Status, p: Painter): string {
  switch (status) {
    case "pass":
      return p.green("PASS");
    case "warn":
      return p.yellow("WARN");
    case "fail":
      return p.red("FAIL");
    case "skip":
      return p.dim("SKIP");
  }
}

// ------------------------------------------------------------------- checks

/**
 * The Node this command is running on — which, launched from the installed
 * application, *is* the Node piorbit ships. Reported with its path so the claim
 * is checkable rather than asserted.
 */
function checkRuntime(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  const origin = runtimeOrigin();
  const where = origin.bundled
    ? `the copy ${PRODUCT_NAME} ships, at ${process.execPath} — not from this machine`
    : `at ${process.execPath}`;
  const data = { version: process.versions.node, execPath: process.execPath, bundled: origin.bundled };

  if (major < MIN_NODE_MAJOR) {
    return {
      name: "runtime",
      status: "fail",
      detail: `node ${process.version} ${where}; ${PRODUCT_NAME} needs Node ${MIN_NODE_MAJOR} or newer`,
      fix: origin.bundled
        ? `This install is damaged — reinstall ${PRODUCT_NAME}.`
        : `Run ${PRODUCT_NAME} with Node ${MIN_NODE_MAJOR} or newer, or install the ${PRODUCT_NAME} application, which brings its own.`,
      data,
    };
  }
  return { name: "runtime", status: "pass", detail: `node ${process.version} — ${where}`, data };
}

/**
 * Packaged, this file lives at
 * `<root>/resources/app.asar.unpacked/node_modules/@piorbit/cli/dist/…` and the
 * runtime at `<root>/resources/runtime/node`. Sharing that prefix is what makes
 * "it came with the app" a fact rather than a hope.
 */
function runtimeOrigin(): { bundled: boolean; resources?: string } {
  const marker = `${sep}resources${sep}app.asar.unpacked${sep}`;
  const here = fileURLToPath(import.meta.url);
  const at = here.indexOf(marker);
  if (at < 0) return { bundled: false };
  const resources = here.slice(0, at + `${sep}resources`.length);
  return { bundled: process.execPath.startsWith(`${resources}${sep}`), resources };
}

// ---------------------------------------------------------- the bundled agent

/** The JSON contract of `@piorbit/worker`'s `resolve-pi.js`. */
type AgentReport =
  | {
      ok: true;
      agent: {
        package: string;
        version: string;
        pinned: string;
        packageDir: string;
        bin: string;
        loaded?: boolean;
        loadMs?: number;
      };
      runtime: { execPath: string; version: string };
      worker: { dir: string; searched: string[] };
      machine: { commandOnPath?: string; homeAgentDir?: string };
    }
  | {
      ok: false;
      error: string;
      fix: string;
      runtime: { execPath: string; version: string };
      machine: { commandOnPath?: string; homeAgentDir?: string };
    };

type AgentInspection =
  | { ok: true; report: Extract<AgentReport, { ok: true }> }
  | { ok: false; error: string; fix: string; machine: { commandOnPath?: string; homeAgentDir?: string } };

/**
 * Ask the worker's own resolver, in a child process, with this Node. Spawning
 * rather than importing is the point: the answer has to come from the place a
 * worker will really load the agent from, and `--check` imports it so a missing
 * transitive package is caught here instead of at somebody's first prompt.
 */
async function inspectBundledAgent(timeoutMs: number): Promise<AgentInspection> {
  let script: string;
  try {
    const workerManifest = createRequire(import.meta.url).resolve("@piorbit/worker/package.json");
    script = join(dirname(workerManifest), "dist", "resolve-pi.js");
  } catch (error) {
    return {
      ok: false,
      error: `${PRODUCT_NAME} cannot find its own worker package, so it cannot locate the agent (${messageOf(error)}).`,
      fix: `This install is incomplete. Reinstall ${PRODUCT_NAME}, or run \`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install\` in a source checkout.`,
      machine: {},
    };
  }
  if (!existsSync(script)) {
    return {
      ok: false,
      error: `the agent resolver is missing at ${script}.`,
      fix: `Build the workspace (\`pnpm -r build\`), or reinstall ${PRODUCT_NAME}.`,
      machine: {},
    };
  }

  const stdout = await new Promise<string>((settle) => {
    execFile(
      process.execPath,
      [script, "--check"],
      { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (_error, out) => settle(out),
    );
  });
  const report = parseAgentReport(stdout);
  if (!report) {
    return {
      ok: false,
      error: `the agent resolver gave no answer, so ${PRODUCT_NAME} cannot say which agent it would run.`,
      fix: `Reinstall ${PRODUCT_NAME}. If it happens again, please report it with the output of \`${PRODUCT_NAME} doctor --json\`.`,
      machine: {},
    };
  }
  if (!report.ok) return { ok: false, error: report.error, fix: report.fix, machine: report.machine ?? {} };
  return { ok: true, report };
}

function parseAgentReport(stdout: string): AgentReport | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as AgentReport;
      if (typeof parsed?.ok === "boolean") return parsed;
    } catch {
      // Not the report line; keep looking backwards.
    }
  }
  return undefined;
}

/** Three rows from one answer: it is there, it is the pinned one, it loads. */
function agentChecks(inspection: AgentInspection): Check[] {
  if (!inspection.ok) {
    return [
      { name: "agent", status: "fail", detail: inspection.error, fix: inspection.fix },
      { name: "agent pin", status: "skip", detail: "needs the agent" },
      { name: "agent loads", status: "skip", detail: "needs the agent" },
    ];
  }
  const { agent } = inspection.report;
  return [
    {
      name: "agent",
      status: "pass",
      detail: `${agent.package} ${agent.version} — shipped inside ${PRODUCT_NAME} at ${agent.packageDir}, not from this machine`,
      data: { package: agent.package, version: agent.version, packageDir: agent.packageDir, bin: agent.bin },
    },
    {
      name: "agent pin",
      status: "pass",
      detail: `${agent.version} is exactly the version ${PRODUCT_NAME} pins`,
      data: { version: agent.version, pinned: agent.pinned },
    },
    {
      name: "agent loads",
      status: "pass",
      detail: `the whole agent loaded in ${formatDuration(agent.loadMs ?? 0)}`,
      data: { loadMs: agent.loadMs ?? 0 },
    },
  ];
}

/**
 * The row that makes "piorbit ignores your own agent" visible. It is a PASS
 * whether or not one is installed: finding one is not a problem, it is the
 * proof that piorbit left it alone.
 */
function checkMachineAgent(inspection: AgentInspection, paths: PiorbitPaths): Check {
  const machine = inspection.ok ? inspection.report.machine : inspection.machine;
  const found = [
    machine.commandOnPath ? `a command at ${machine.commandOnPath}` : "",
    machine.homeAgentDir ? `a directory at ${machine.homeAgentDir}` : "",
  ].filter(Boolean);

  if (found.length === 0) {
    return {
      name: "this machine",
      status: "pass",
      detail: `no agent of its own — ${PRODUCT_NAME} does not need one`,
      data: { commandOnPath: null, homeAgentDir: null },
    };
  }
  // Never a warning of its own: the sharing case is one condition, and the
  // `agent dir` row owns it. Two warnings for one problem is noise.
  const sharing = machine.homeAgentDir !== undefined && paths.agentDir === machine.homeAgentDir;
  return {
    name: "this machine",
    status: "pass",
    detail: sharing
      ? `${found.join(" and ")} — ${PRODUCT_NAME} is currently sharing that directory (see the agent dir row)`
      : `${found.join(" and ")} — ${PRODUCT_NAME} runs neither`,
    data: {
      commandOnPath: machine.commandOnPath ?? null,
      homeAgentDir: machine.homeAgentDir ?? null,
      shared: sharing,
    },
  };
}

/**
 * The agent directory, plus one thing `checkWritableDir` cannot know: whether
 * it belongs to piorbit at all. A directory shared with another installation is
 * usable, and it is also how two programs end up fighting over one settings
 * file, so it is said out loud.
 */
function agentDirChecks(paths: PiorbitPaths): Check[] {
  const check = checkWritableDir("agent dir", paths.agentDir, false, "--agent-dir");
  const stock = join(homedir(), ".pi", "agent");
  if (paths.agentDir !== stock || check.status === "fail") return [check];
  return [
    {
      ...check,
      status: check.status === "pass" ? "warn" : check.status,
      detail: `${check.detail} — this directory belongs to a separate agent installation`,
      fix:
        `${PRODUCT_NAME} keeps its own settings, credentials and sessions apart from anything else on this machine, ` +
        `and sharing this directory means two programs writing one settings file. Give ${PRODUCT_NAME} its own by ` +
        `setting ${ENV.agentDir} — the ${PRODUCT_NAME} application does this for you.`,
    },
  ];
}

/**
 * Running the agent's own command, which is a different code path from loading
 * it as a library: `piorbit pi` and the `piorbit packages` verbs go through the
 * command, workers go through the library, and either can be broken alone.
 */
async function checkAgentCommand(paths: PiorbitPaths, timeoutMs: number): Promise<Check> {
  const started = Date.now();
  try {
    const result = await withTimeout(
      // A directory that certainly exists: the state dir may be exactly what is
      // broken, and a missing cwd would fail the spawn for the wrong reason.
      runPi(["--version"], { paths, global: false, stdio: "pipe", cwd: tmpdir() }),
      timeoutMs,
      `the agent did not answer \`--version\` within ${Math.round(timeoutMs / 1000)}s`,
    );
    const took = formatDuration(Date.now() - started);
    if (result.code === 0) {
      const version = result.stdout.trim().split("\n")[0] ?? "";
      return { name: "agent command", status: "pass", detail: `${version || "ok"} (${took})`, data: { took } };
    }
    return {
      name: "agent command",
      status: "fail",
      detail: `it exited ${result.signal ?? result.code}: ${firstMeaningfulLine(result.stderr || result.stdout)}`,
      fix: `This install is incomplete — reinstall ${PRODUCT_NAME}. From a source checkout: \`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install\`.`,
    };
  } catch (error) {
    return {
      name: "agent command",
      status: "fail",
      detail: messageOf(error),
      fix: `Try it by hand: \`${PRODUCT_NAME} pi --version\`.`,
    };
  }
}

function checkWritableDir(name: string, dir: string, create: boolean, flag: string): Check {
  try {
    if (!existsSync(dir)) {
      if (!create) {
        return {
          name,
          status: "warn",
          detail: `${dir} does not exist yet`,
          fix: `It is created on first use. To create it now: \`mkdir -p ${dir}\`, or point elsewhere with \`${flag} <dir>\`.`,
          data: { path: dir, exists: false },
        };
      }
      mkdirSync(dir, { recursive: true });
    }
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `${dir} is not writable: ${messageOf(error)}`,
      fix: `Fix its permissions, or point elsewhere with \`${flag} <dir>\`.`,
      data: { path: dir },
    };
  }

  let free: number | undefined;
  try {
    const stats = statfsSync(dir);
    free = stats.bavail * stats.bsize;
  } catch {
    // statfs is unavailable on some filesystems; the writability check stands.
  }
  if (free !== undefined && free < LOW_DISK_BYTES) {
    return {
      name,
      status: "warn",
      detail: `${dir} — only ${formatBytes(free)} free`,
      fix: "Sessions are append-only JSONL and grow. Free some space before a long run.",
      data: { path: dir, freeBytes: free },
    };
  }
  return {
    name,
    status: "pass",
    detail: free === undefined ? dir : `${dir} (${formatBytes(free)} free)`,
    data: { path: dir, ...(free !== undefined ? { freeBytes: free } : {}) },
  };
}

/**
 * Provider credentials, read from Pi's own store as JSON. Only names, types and
 * expiry are reported — a key or token is never read into a printable string.
 */
function checkProviders(paths: PiorbitPaths): Check {
  const authPath = join(paths.agentDir, "auth.json");
  const envProviders = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY"].filter(
    (name) => (process.env[name] ?? "") !== "",
  );

  let parsed: Record<string, { type?: string; expires?: number }> = {};
  if (existsSync(authPath)) {
    try {
      const raw = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected a JSON object");
      parsed = raw as Record<string, { type?: string; expires?: number }>;
    } catch (error) {
      return {
        name: "providers",
        status: "fail",
        detail: `${authPath} is not readable as JSON: ${messageOf(error)}`,
        fix: `Pi refuses to start with a broken auth.json. Re-authenticate with \`${PRODUCT_NAME} pi\` and its /login command.`,
      };
    }
  }

  const now = Date.now();
  const providers = Object.entries(parsed).map(([id, credential]) => {
    const expires = typeof credential?.expires === "number" ? credential.expires : undefined;
    const expiresAt = isoOrUndefined(expires);
    return {
      id,
      type: credential?.type ?? "unknown",
      ...(expiresAt ? { expiresAt } : {}),
      expired: expires !== undefined && expires < now,
    };
  });
  const expired = providers.filter((provider) => provider.expired);

  if (providers.length === 0 && envProviders.length === 0) {
    return {
      name: "providers",
      status: "fail",
      detail: `no credentials in ${authPath} and no provider key in the environment`,
      fix:
        `Open ${PRODUCT_NAME} and sign in to a provider — the first-run flow asks for one, and ` +
        `Settings → Models can add one at any time. From a terminal: \`${PRODUCT_NAME} pi\`, then /login.`,
      data: { authPath, providers: [] },
    };
  }
  const names = providers.map((provider) => `${provider.id}${provider.type === "oauth" ? " (oauth)" : ""}`);
  const detail = [names.join(", "), envProviders.length > 0 ? `env: ${envProviders.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");

  if (expired.length > 0) {
    return {
      name: "providers",
      status: "warn",
      detail: `${detail} — expired: ${expired.map((provider) => provider.id).join(", ")}`,
      fix: `Re-authenticate the expired provider with \`${PRODUCT_NAME} pi\` and /login. Pi refreshes oauth tokens itself, so this may clear on its own.`,
      data: { authPath, providers },
    };
  }
  return { name: "providers", status: "pass", detail, data: { authPath, providers } };
}

async function checkPort(paths: PiorbitPaths): Promise<Check> {
  const status = await inspectHost(paths);
  if (status.state === "running") {
    return {
      name: "port",
      status: "pass",
      detail: `${paths.port} — held by the ${PRODUCT_NAME} host (pid ${status.record.pid})`,
      data: { port: paths.port, heldByPiorbit: true, pid: status.record.pid },
    };
  }
  if (!(await portInUse(paths.host, paths.port))) {
    return { name: "port", status: "pass", detail: `${paths.port} is free`, data: { port: paths.port, free: true } };
  }
  // Something is listening. A piorbit host with no record of its own is the
  // common case in development (`pnpm sandbox`, or a host started by hand):
  // usable, but `piorbit down` will not know how to stop it.
  if (await probeHealth(hostUrl(paths))) {
    return {
      name: "port",
      status: "warn",
      detail: `${paths.port} — a ${PRODUCT_NAME} host is serving here, but ${PRODUCT_NAME} did not start it`,
      fix: `Use it as it is (${hostUrl(paths)}), or stop it yourself; \`${PRODUCT_NAME} down\` only stops hosts it started.`,
      data: { port: paths.port, free: false, foreignPiorbit: true },
    };
  }
  return {
    name: "port",
    status: "fail",
    detail: `${paths.host}:${paths.port} is in use by something that is not a ${PRODUCT_NAME} host`,
    fix: `See what holds it (\`lsof -nP -iTCP:${paths.port} -sTCP:LISTEN\`), or run ${PRODUCT_NAME} on another port (\`--port\`).`,
    data: { port: paths.port, free: false },
  };
}

/**
 * pi-subagents has no IPC: everything crosses processes through files under a
 * temp root, and the default root is uid-scoped. A root owned by another uid is
 * a real trap — runs started as root are invisible to a piorbit running as you.
 */
async function checkSubagentRoots(paths: PiorbitPaths): Promise<Check[]> {
  const checks: Check[] = [
    checkWritableDir("subagents root", paths.subagentsTempRoot, true, "--subagents-temp-root"),
  ];

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return checks;

  let foreign: string[] = [];
  try {
    const entries = await readdir(tmpdir());
    foreign = entries
      .filter((entry) => /^pi-subagents-uid-\d+$/.test(entry))
      .filter((entry) => entry !== `pi-subagents-uid-${uid}`)
      .map((entry) => join(tmpdir(), entry));
  } catch {
    return checks;
  }

  if (foreign.length === 0) {
    checks.push({
      name: "subagents uids",
      status: "pass",
      detail: `only uid ${uid} roots under ${tmpdir()}`,
      data: { uid, foreign: [] },
    });
    return checks;
  }
  checks.push({
    name: "subagents uids",
    status: "warn",
    detail: `roots for another uid exist: ${foreign.join(", ")}`,
    fix:
      `Background subagent runs started under that uid are invisible to a ${PRODUCT_NAME} running as uid ${uid}. ` +
      `Run everything as one user, or point both at one root with --subagents-temp-root.`,
    data: { uid, foreign },
  });
  return checks;
}

/**
 * The end-to-end check: spawn a real worker in a throwaway project with a
 * throwaway session directory, open a session, and read the model list back.
 * It proves the pinned Pi loads, the driver works, and a model resolves — and
 * it writes nothing into the user's own sessions.
 */
async function checkWorker(
  paths: PiorbitPaths,
  timeoutMs: number,
): Promise<{ check: Check; model: Check; auth: Check }> {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-doctor-`));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  let stderr = "";
  let client: WorkerClient | undefined;
  const started = Date.now();
  try {
    client = new WorkerClient({
      cwd,
      agentDir: paths.agentDir,
      sessionDir,
      subagentsTempRoot: join(root, "subagents"),
      onNotification: () => {},
      onExit: () => {},
      onStderr: (text) => (stderr += text),
    });
    await withTimeout(client.ready, timeoutMs, `the worker did not become ready within ${Math.round(timeoutMs / 1000)}s`);

    const { state } = await withTimeout(
      client.request<{ state: SessionState }>("session/new", { cwd }),
      timeoutMs,
      "the worker did not open a session in time",
    );
    let models: ModelRef[] = [];
    try {
      ({ models } = await withTimeout(
        client.request<{ models: ModelRef[] }>("pi/model/list", { path: state.path }),
        timeoutMs,
        "the worker did not answer pi/model/list in time",
      ));
    } catch {
      // A missing model list is reported by the model check, not this one.
    }

    const took = formatDuration(Date.now() - started);
    const check: Check = {
      name: "worker",
      status: "pass",
      detail: `spawned, opened a session and closed it (${took})`,
      data: { took, sessionId: state.id },
    };
    if (!state.model) {
      return {
        check,
        model: {
          name: "default model",
          status: "fail",
          detail: "a session opened but no model resolved",
          fix:
            "Choose a default model in Settings → Models. If one is already chosen, the provider it " +
            "names has no credentials — sign in to that provider on the same screen.",
          data: { available: models.length },
        },
        auth: { name: "model auth", status: "skip", detail: "no model to check" },
      };
    }
    const model: Check = {
      name: "default model",
      status: "pass",
      detail: `${state.model.provider}/${state.model.id}${models.length > 0 ? ` (${models.length} available)` : ""}`,
      data: { model: state.model, available: models.length },
    };
    return { check, model, auth: await checkModelAuth(paths, state.model, timeoutMs) };
  } catch (error) {
    return {
      check: {
        name: "worker",
        status: "fail",
        detail: messageOf(error),
        fix: stderr.trim()
          ? `The worker said: ${firstMeaningfulLine(stderr)}`
          : `Build the workspace (\`pnpm -r build\`), then run \`${PRODUCT_NAME} doctor\` again.`,
        data: { stderr: stderr.slice(-2000) },
      },
      model: { name: "default model", status: "skip", detail: "the worker did not start" },
      auth: { name: "model auth", status: "skip", detail: "the worker did not start" },
    };
  } finally {
    await client?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Ask Pi itself whether the resolved model's provider is usable. `pi auth check
 * --json` without `--credentials` answers with a status and a reason and never
 * emits the credential, which is exactly what a doctor should print.
 */
async function checkModelAuth(paths: PiorbitPaths, model: ModelRef, timeoutMs: number): Promise<Check> {
  try {
    const result = await withTimeout(
      runPi(["auth", "check", "--provider", model.provider, "--model", model.id, "--json", "--no-refresh"], {
        paths,
        global: false,
        stdio: "pipe",
        cwd: tmpdir(),
      }),
      timeoutMs,
      "`pi auth check` did not answer in time",
    );
    const line = result.stdout
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.startsWith("{"));
    const parsed = line ? (JSON.parse(line) as { status?: string; reason?: string; provider?: string }) : undefined;

    if (parsed?.status === "ready") {
      return {
        name: "model auth",
        status: "pass",
        detail: `${model.provider} is ready`,
        data: { provider: model.provider, status: parsed.status },
      };
    }
    return {
      name: "model auth",
      status: "fail",
      detail: `${model.provider} is ${parsed?.status ?? "not usable"}${parsed?.reason ? ` (${parsed.reason})` : ""}`,
      fix: `Authenticate it: \`${PRODUCT_NAME} pi\` then /login, or export the provider's API key. Pi's own view: \`${PRODUCT_NAME} pi auth check --provider ${model.provider}\`.`,
      data: { provider: model.provider, ...(parsed ?? {}) },
    };
  } catch (error) {
    return {
      name: "model auth",
      status: "warn",
      detail: `could not ask Pi about ${model.provider}: ${messageOf(error)}`,
      fix: `Try it directly: \`${PRODUCT_NAME} pi auth check --provider ${model.provider}\`.`,
    };
  }
}

// ------------------------------------------------------------------ helpers

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `expires` is Pi's, so it may be anything; never let it throw a Date error. */
function isoOrUndefined(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line ? (line.length > 160 ? `${line.slice(0, 159)}…` : line) : "(no output)";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
