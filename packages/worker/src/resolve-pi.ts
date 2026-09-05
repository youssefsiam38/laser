/**
 * Where the agent comes from — and the proof that it does not come from this
 * machine (M10-T3).
 *
 * piorbit ships the agent. It is pinned to an exact version in
 * `packages/worker/package.json`, it is copied into the application package as
 * real files, and it is found by walking **this file's own `node_modules`
 * chain** — never `PATH`, never a global install, never a user directory. That
 * is the whole claim of a self-contained app, and it is enforced here rather
 * than asserted in a comment: there is no code path in this module that can
 * reach anything outside the package tree that contains it.
 *
 * Three things are checked, in the order they can fail:
 *
 *   1. **It is there.** The pinned package resolves, and its entry file exists.
 *   2. **It is the pinned one.** The version on disk equals the version in git.
 *      A packager that quietly swapped it, a partial install, or a bump nobody
 *      tested must stop the app rather than run an unexpected agent.
 *   3. **It actually loads.** `--check` imports the agent, which is the only
 *      way to catch a missing *transitive* package: the agent's own bundle
 *      imports `@earendil-works/pi-server`, and a tree that resolved the entry
 *      file happily still dies on the first import. That failure has shipped
 *      before; it is not hypothetical.
 *
 * Run as a script it prints one JSON object and exits non-zero on failure, so
 * the Electron shell and `piorbit doctor` can ask the *bundled* Node — the
 * binary the workers really use — instead of guessing from their own process.
 *
 * This module imports Pi only inside `--check`, and nothing else in it touches
 * the agent. It is deliberately dependency-free so it can be spawned on its own.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent package piorbit ships. Pinned in `packages/worker/package.json`. */
export const AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/** An exact version, and nothing else: `^`, `~` and `*` are not pins. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

export interface BundledAgent {
  packageName: string;
  /** Absolute path to the agent package inside piorbit's own tree. */
  packageDir: string;
  /** Absolute path to the agent's CLI entry, inside `packageDir`. */
  bin: string;
  /** The version on disk. */
  version: string;
  /** The version `packages/worker/package.json` pins, which lives in git. */
  pinnedVersion: string;
  /** The package this search started from; the anchor for everything above. */
  workerDir: string;
  /** Every directory the search looked in, best first. Nothing else was consulted. */
  searched: string[];
}

/**
 * A failure a person has to read. `message` is what is wrong; `fix` is what to
 * do about it. Neither is ever a stack trace.
 */
export class AgentResolutionError extends Error {
  override readonly name = "AgentResolutionError";
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

/** The worker package this file was built into: `<…>/@lasercode/worker`. */
export function workerPackageDir(): string {
  // `dist/resolve-pi.js` → the package root. `rootDir: src` / `outDir: dist`
  // makes this one level in both the source tree and the built one.
  return resolvePath(fileURLToPath(new URL("../", import.meta.url)));
}

/**
 * The pin, read from the manifest in git. Not a constant in this file on
 * purpose: two places that state the version can disagree, and the one the
 * installer obeys is the manifest.
 */
export function pinnedAgentVersion(workerDir = workerPackageDir()): string {
  const manifestPath = join(workerDir, "package.json");
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
  } catch (error) {
    throw new AgentResolutionError(
      `${PRODUCT_NAME} cannot read its own manifest at ${manifestPath}, so it does not know which agent version it ships.`,
      `This install is incomplete. Reinstall ${PRODUCT_NAME}. (${messageOf(error)})`,
    );
  }
  const pinned = manifest.dependencies?.[AGENT_PACKAGE];
  if (!pinned) {
    throw new AgentResolutionError(
      `${manifestPath} does not pin ${AGENT_PACKAGE}, so there is nothing to check the installed agent against.`,
      `Add "${AGENT_PACKAGE}": "<exact version>" to its dependencies and reinstall.`,
    );
  }
  if (!EXACT_VERSION.test(pinned)) {
    throw new AgentResolutionError(
      `the agent is pinned as "${pinned}", which is a range rather than a version.`,
      `Pin it exactly in ${manifestPath} — a range means two machines can ship two different agents.`,
    );
  }
  return pinned;
}

/**
 * `<dir>/node_modules/<name>`, walking up to the filesystem root — Node's own
 * lookup for a bare specifier, minus the `exports` gate that stops us reading
 * a manifest. Works for a flat tree (what the packaged app has), for pnpm's
 * symlinked one, and for a yarn node-modules linker alike.
 *
 * Deliberately duplicated from `@lasercode/cli`: the CLI depends on this package,
 * so this package cannot depend on the CLI, and the resolution that decides
 * which agent a worker loads must live next to the worker.
 */
export function findInNodeModules(from: string, name: string): { dir?: string; searched: string[] } {
  const searched: string[] = [];
  let dir = resolvePath(from);
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    searched.push(candidate);
    if (existsSync(join(candidate, "package.json"))) return { dir: candidate, searched };
    const parent = dirname(dir);
    if (parent === dir) return { searched };
    dir = parent;
  }
}

/**
 * Find the agent piorbit ships. Throws an `AgentResolutionError` when it is
 * missing or unusable; does **not** check the version — `assertBundledAgent`
 * does that, so a caller can report "found, but wrong" as its own failure.
 */
export function resolveBundledAgent(workerDir = workerPackageDir()): BundledAgent {
  const pinnedVersion = pinnedAgentVersion(workerDir);
  const { dir: packageDir, searched } = findInNodeModules(workerDir, AGENT_PACKAGE);
  if (!packageDir) {
    throw new AgentResolutionError(
      `${PRODUCT_NAME} could not find the agent it ships (${AGENT_PACKAGE} ${pinnedVersion}).`,
      `This install is incomplete — reinstall ${PRODUCT_NAME}. From a source checkout, run ` +
        "`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` at the repository root.",
    );
  }

  const manifestPath = join(packageDir, "package.json");
  let manifest: { version?: string; bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch (error) {
    throw new AgentResolutionError(
      `the agent at ${packageDir} has an unreadable manifest.`,
      `This install is damaged — reinstall ${PRODUCT_NAME}. (${messageOf(error)})`,
    );
  }
  const version = manifest.version ?? "";
  if (version === "") {
    throw new AgentResolutionError(
      `the agent at ${packageDir} does not say which version it is.`,
      `This install is damaged — reinstall ${PRODUCT_NAME}.`,
    );
  }
  const binField = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["pi"];
  if (!binField) {
    throw new AgentResolutionError(
      `the agent at ${packageDir} ships no command to run.`,
      `This install is damaged — reinstall ${PRODUCT_NAME}.`,
    );
  }
  const bin = resolvePath(packageDir, binField);
  if (!existsSync(bin)) {
    throw new AgentResolutionError(
      `the agent is installed at ${packageDir} but its program file is missing (${bin}).`,
      `This install is incomplete — reinstall ${PRODUCT_NAME}. A packager that stored the tree as symlinks ` +
        "rather than files is the usual cause.",
    );
  }

  return { packageName: AGENT_PACKAGE, packageDir, bin, version, pinnedVersion, workerDir, searched };
}

/**
 * The agent, or a refusal to run. Every process that is about to load the agent
 * calls this first: running a version nobody pinned is worse than not starting.
 */
export function assertBundledAgent(workerDir = workerPackageDir()): BundledAgent {
  const agent = resolveBundledAgent(workerDir);
  if (agent.version !== agent.pinnedVersion) {
    throw new AgentResolutionError(
      `${PRODUCT_NAME} ships agent ${agent.pinnedVersion}, but the copy in this install is ${agent.version}.`,
      `Reinstall ${PRODUCT_NAME} so the two match. From a source checkout, ` +
        "`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` at the repository root restores the pinned version.",
    );
  }
  return agent;
}

// --------------------------------------------------------------- reporting

/**
 * What the machine happens to have. Read for one reason only: so `piorbit
 * doctor` can say "you have one, and piorbit is not using it" out loud. Nothing
 * in this module ever resolves through these values.
 */
export interface MachineAgent {
  /** An agent command on `PATH`, if there is one. Never used. */
  commandOnPath?: string;
  /** The default agent directory of a stock install. Never read or written. */
  homeAgentDir?: string;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function machineAgent(env: NodeJS.ProcessEnv = process.env): MachineAgent {
  const found: MachineAgent = {};
  const extensions = process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  outer: for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, `pi${extension}`);
      if (isExecutableFile(candidate)) {
        found.commandOnPath = candidate;
        break outer;
      }
    }
  }
  const home = env["HOME"] ?? env["USERPROFILE"];
  if (home) {
    const stock = join(home, ".pi", "agent");
    if (existsSync(stock)) found.homeAgentDir = stock;
  }
  return found;
}

/** The JSON one line of `node dist/resolve-pi.js` prints. */
export type AgentReport =
  | {
      ok: true;
      agent: {
        package: string;
        version: string;
        pinned: string;
        packageDir: string;
        bin: string;
        /** Present only with `--check`: the agent's whole import graph loaded. */
        loaded?: boolean;
        loadMs?: number;
      };
      runtime: { execPath: string; version: string };
      worker: { dir: string; searched: string[] };
      machine: MachineAgent;
    }
  | {
      ok: false;
      error: string;
      fix: string;
      runtime: { execPath: string; version: string };
      machine: MachineAgent;
    };

const runtimeOf = (): { execPath: string; version: string } => ({
  execPath: process.execPath,
  version: process.version,
});

/**
 * Resolve, check the pin, and — with `check` — import the agent so a missing
 * transitive package fails here rather than on a person's first prompt.
 */
export async function agentReport(options: { check: boolean }): Promise<AgentReport> {
  try {
    const agent = assertBundledAgent();
    const loaded: { loaded?: boolean; loadMs?: number } = {};
    if (options.check) {
      const started = Date.now();
      try {
        await import(AGENT_PACKAGE);
      } catch (error) {
        const missing = missingPackageOf(error);
        return {
          ok: false,
          error: missing
            ? `the agent ${PRODUCT_NAME} ships is incomplete: it needs ${missing}, which is not in this install.`
            : `the agent ${PRODUCT_NAME} ships did not load: ${messageOf(error)}`,
          fix: missing
            ? `Reinstall ${PRODUCT_NAME}. If you are building it, ${missing} has to be a declared dependency of ` +
              `@lasercode/worker so the packager copies it — a pnpm-only override is invisible to the packager.`
            : `Reinstall ${PRODUCT_NAME}. If it happens again, please report it with this message.`,
          runtime: runtimeOf(),
          machine: machineAgent(),
        };
      }
      loaded.loaded = true;
      loaded.loadMs = Date.now() - started;
    }
    return {
      ok: true,
      agent: {
        package: agent.packageName,
        version: agent.version,
        pinned: agent.pinnedVersion,
        packageDir: agent.packageDir,
        bin: agent.bin,
        ...loaded,
      },
      runtime: runtimeOf(),
      worker: { dir: agent.workerDir, searched: agent.searched },
      machine: machineAgent(),
    };
  } catch (error) {
    if (error instanceof AgentResolutionError) {
      return { ok: false, error: error.message, fix: error.fix, runtime: runtimeOf(), machine: machineAgent() };
    }
    return {
      ok: false,
      error: messageOf(error),
      fix: `Reinstall ${PRODUCT_NAME}. If it happens again, please report it with this message.`,
      runtime: runtimeOf(),
      machine: machineAgent(),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `ERR_MODULE_NOT_FOUND` names the package it wanted; pull it out for the fix line. */
function missingPackageOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") return undefined;
  const quoted = /Cannot find (?:package|module) '([^']+)'/.exec(error.message);
  return quoted?.[1];
}

// ------------------------------------------------------------------ script

/**
 * `node dist/resolve-pi.js [--check]` prints the report as one JSON line.
 *
 * Spawning this is how the Electron shell and `piorbit doctor` get an answer
 * from the *bundled* Node in the *worker's* own location, which is the only
 * place the answer means anything.
 */
/**
 * `import.meta.url` is the *real* path — Node resolves symlinks before it runs
 * a module — while `process.argv[1]` is whatever the caller typed, which under
 * pnpm is a symlink into the virtual store. Comparing them without resolving
 * both makes this file silently print nothing in a development checkout and
 * work perfectly in the packaged app, which is the worst of both worlds.
 */
const invokedDirectly = (() => {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolvePath(path);
    }
  };
  return real(argv) === real(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) {
  const report = await agentReport({ check: process.argv.includes("--check") });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}
