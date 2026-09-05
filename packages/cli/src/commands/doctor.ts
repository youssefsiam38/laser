/**
 * `piorbit doctor` — the command that has to earn trust.
 *
 * Every check answers a question a broken setup actually raises, in the order a
 * failure would cascade: the runtime, the pinned Pi, the directories, the
 * credentials, the port, the subagent roots, and finally a real worker with a
 * real session, which is the only check that proves the whole chain.
 *
 * Rules this file keeps:
 *   - no check ever prints a secret; credentials are reported by provider name,
 *     type and expiry only;
 *   - every non-PASS row carries a fix that is a command or a decision, not
 *     "check your configuration";
 *   - a check that cannot run says so (SKIP) instead of passing quietly.
 */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerClient } from "@piorbit/host";
import type { ModelRef, SessionState } from "@piorbit/protocol";
import { bool } from "../args.js";
import type { Command } from "../command.js";
import { hostUrl, type PiorbitPaths } from "../config.js";
import { ExitCode, messageOf } from "../errors.js";
import { inspectHost, portInUse, probeHealth } from "../hostfile.js";
import type { Painter, Terminal } from "../output.js";
import { resolvePinnedPi, runPi } from "../pi.js";
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
  summary: "check that piorbit can actually work, and say how to fix what cannot",
  usage: "piorbit doctor [--skip-worker] [--timeout <seconds>]",
  description: `
Checks the Node version, the pinned Pi (that it resolves, and that it boots),
the agent, session and state directories, provider credentials (names only —
never a secret), the host port, the pi-subagents temp roots, and finally spawns
a throwaway worker in a temporary directory and opens a session in it.

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
    { note: "the usual", command: "piorbit doctor" },
    { note: "fast checks only", command: "piorbit doctor --skip-worker" },
    { note: "in CI", command: "piorbit doctor --json --no-color" },
  ],
  async run({ term, paths, args }) {
    const timeoutMs = Math.max(1, args.flags["timeout"] === undefined ? 60 : Number(args.flags["timeout"])) * 1000;
    const checks: Check[] = [];

    checks.push(checkNode());
    const pi = checkPinnedPi();
    checks.push(pi.check);
    if (pi.bin) checks.push(await checkPiBoots(paths, timeoutMs));
    checks.push(checkWritableDir("agent dir", paths.agentDir, false, "--agent-dir"));
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
        fix: "Run `piorbit doctor` without --skip-worker to prove a session really opens.",
      });
      checks.push({ name: "default model", status: "skip", detail: "needs the worker check" });
      checks.push({ name: "model auth", status: "skip", detail: "needs the worker check" });
    } else if (!pi.bin) {
      checks.push({
        name: "worker",
        status: "skip",
        detail: "skipped: the pinned Pi did not resolve",
        fix: "Fix the pinned Pi first; this check cannot run without it.",
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
    if (failed === 0 && warned === 0) term.note(term.err.dim("piorbit is ready. `piorbit up` starts the app."));
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

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { name: "node", status: "pass", detail: `v${process.versions.node}`, data: { version: process.versions.node } };
  }
  return {
    name: "node",
    status: "fail",
    detail: `v${process.versions.node}; piorbit needs Node ${MIN_NODE_MAJOR} or newer`,
    fix: `Install Node ${MIN_NODE_MAJOR} (\`nvm install ${MIN_NODE_MAJOR}\`) and run piorbit with it.`,
    data: { version: process.versions.node },
  };
}

function checkPinnedPi(): { check: Check; bin?: string } {
  try {
    const pi = resolvePinnedPi();
    return {
      bin: pi.bin,
      check: {
        name: "pinned pi",
        status: "pass",
        detail: `${pi.version} at ${pi.packageDir}`,
        data: { version: pi.version, packageDir: pi.packageDir, bin: pi.bin },
      },
    };
  } catch (error) {
    return {
      check: {
        name: "pinned pi",
        status: "fail",
        detail: messageOf(error),
        fix: "Run `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` at the repo root, then `pnpm -r build`.",
      },
    };
  }
}

/**
 * Booting Pi is a separate check from resolving it because the failure that
 * bites here is a *packaging* one: 0.85.0's bundle imports a package it does
 * not declare, which resolves under npm's hoisting and not under pnpm's
 * (docs/research/findings.md). Only running it catches that.
 */
async function checkPiBoots(paths: PiorbitPaths, timeoutMs: number): Promise<Check> {
  const started = Date.now();
  try {
    const result = await withTimeout(
      // A directory that certainly exists: the state dir may be exactly what is
      // broken, and a missing cwd would fail the spawn for the wrong reason.
      runPi(["--version"], { paths, global: false, stdio: "pipe", cwd: tmpdir() }),
      timeoutMs,
      `Pi did not answer \`--version\` within ${Math.round(timeoutMs / 1000)}s`,
    );
    const took = formatDuration(Date.now() - started);
    if (result.code === 0) {
      const version = result.stdout.trim().split("\n")[0] ?? "";
      return { name: "pi boots", status: "pass", detail: `${version || "ok"} (${took})`, data: { took } };
    }
    return {
      name: "pi boots",
      status: "fail",
      detail: `\`pi --version\` exited ${result.signal ?? result.code}: ${firstMeaningfulLine(result.stderr || result.stdout)}`,
      fix: "If it cannot find a module, reinstall from the repo root: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install`.",
    };
  } catch (error) {
    return {
      name: "pi boots",
      status: "fail",
      detail: messageOf(error),
      fix: "Try it by hand: `piorbit pi --version`.",
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
        fix: "Pi refuses to start with a broken auth.json. Re-authenticate with `piorbit pi` and its /login command.",
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
      fix: "Run `piorbit pi` and use its /login command, or export a provider API key.",
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
      fix: "Re-authenticate the expired provider with `piorbit pi` and /login. Pi refreshes oauth tokens itself, so this may clear on its own.",
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
      detail: `${paths.port} — held by the piorbit host (pid ${status.record.pid})`,
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
      detail: `${paths.port} — a piorbit host is serving here, but piorbit did not start it`,
      fix: `Use it as it is (${hostUrl(paths)}), or stop it yourself; \`piorbit down\` only stops hosts it started.`,
      data: { port: paths.port, free: false, foreignPiorbit: true },
    };
  }
  return {
    name: "port",
    status: "fail",
    detail: `${paths.host}:${paths.port} is in use by something that is not a piorbit host`,
    fix: `See what holds it (\`lsof -nP -iTCP:${paths.port} -sTCP:LISTEN\`), or run piorbit on another port (\`--port\`).`,
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
      `Background subagent runs started under that uid are invisible to a piorbit running as uid ${uid}. ` +
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
  const root = mkdtempSync(join(tmpdir(), "piorbit-doctor-"));
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
          fix: "Set one in Pi's settings (`piorbit pi` → /model), or check that the provider it names has credentials.",
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
          : "Build the workspace (`pnpm -r build`), then run `piorbit doctor` again.",
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
      fix: `Authenticate it: \`piorbit pi\` then /login, or export the provider's API key. Pi's own view: \`piorbit pi auth check --provider ${model.provider}\`.`,
      data: { provider: model.provider, ...(parsed ?? {}) },
    };
  } catch (error) {
    return {
      name: "model auth",
      status: "warn",
      detail: `could not ask Pi about ${model.provider}: ${messageOf(error)}`,
      fix: `Try it directly: \`piorbit pi auth check --provider ${model.provider}\`.`,
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
