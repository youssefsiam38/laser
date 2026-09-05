/**
 * Reaching Pi without leaving piorbit's world.
 *
 * `piorbit pi ...` runs the Pi that `@piorbit/worker` pins (AGENTS.md invariant
 * 4), not whatever `pi` happens to be on `$PATH`, and runs it with piorbit's
 * agent dir and pi-subagents temp root. That is the whole point: a session you
 * start from the terminal this way shows up in the app, and a background
 * subagent run lands in the root the host watches.
 *
 * Resolving a path is not importing Pi. Nothing in this package imports
 * `@earendil-works/*`; it only asks Node where the worker's copy lives.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { CliError, ExitCode } from "./errors.js";
import { piEnv, type PiorbitPaths } from "./config.js";

export interface PiResolution {
  /** Absolute path to Pi's CLI entry (`dist/bundle/cli.js` in 0.85). */
  bin: string;
  packageDir: string;
  packageName: string;
  version: string;
  source: "pinned" | "global";
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const signals = osConstants.signals as unknown as Record<string, number>;

/**
 * The pinned Pi: resolved *through* `@piorbit/worker`, so it is by construction
 * the same copy a worker loads. Resolving from this package instead would find
 * a hoisted or global one.
 */
export function resolvePinnedPi(): PiResolution {
  let workerPackageJson: string;
  try {
    workerPackageJson = createRequire(import.meta.url).resolve("@piorbit/worker/package.json");
  } catch (error) {
    throw new CliError("cannot find @piorbit/worker, so the pinned Pi cannot be located", {
      fix: "Run `pnpm install` at the repo root, then `pnpm -r build`.",
      cause: error,
    });
  }

  // Pi 0.85's `exports` has no `require` condition and does not export
  // `./package.json`, so `createRequire().resolve()` cannot find it from here.
  // Walk the worker's node_modules chain instead — the same directories Node
  // would search, minus the exports gate. Reading the manifest is how we learn
  // the version and the `bin` name without importing anything.
  const packageDir = findInNodeModules(dirname(workerPackageJson), PI_PACKAGE);
  if (!packageDir) {
    const pinned = pinnedVersionFromWorker(workerPackageJson);
    throw new CliError(`the pinned Pi (${PI_PACKAGE}${pinned ? `@${pinned}` : ""}) is not installed`, {
      details: [`Searched the node_modules chain above ${dirname(workerPackageJson)}`],
      fix: "Run `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` at the repo root.",
    });
  }
  const piPackageJson = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(piPackageJson, "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  const binField = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["pi"];
  if (!binField) {
    throw new CliError(`${PI_PACKAGE}@${manifest.version ?? "?"} declares no \`pi\` binary`, {
      details: [`Manifest: ${piPackageJson}`],
      fix: "This is a broken Pi install. Reinstall with `pnpm install --force` at the repo root.",
    });
  }
  const bin = resolve(packageDir, binField);
  if (!existsSync(bin)) {
    throw new CliError(`the pinned Pi is installed but its entry file is missing: ${bin}`, {
      fix: "Reinstall it with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --force` at the repo root.",
    });
  }

  return { bin, packageDir, packageName: PI_PACKAGE, version: manifest.version ?? "unknown", source: "pinned" };
}

/**
 * `<dir>/node_modules/<name>`, walking up to the filesystem root — Node's own
 * lookup order for a bare specifier. Works for npm's flat layout, pnpm's
 * symlinked one, and a yarn node-modules linker alike.
 */
export function findInNodeModules(from: string, name: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function pinnedVersionFromWorker(workerPackageJson: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(workerPackageJson, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return manifest.dependencies?.[PI_PACKAGE];
  } catch {
    return undefined;
  }
}

/** The user's own `pi`, for `--global-pi`. Reported honestly as `global`. */
export function resolveGlobalPi(env: NodeJS.ProcessEnv = process.env): PiResolution {
  const bin = which("pi", env);
  if (!bin) {
    throw new CliError("no `pi` found on PATH", {
      fix: `Install Pi globally (\`npm i -g @earendil-works/pi-coding-agent\`), or drop --global-pi to use the Pi ${PRODUCT_NAME} pins.`,
      exitCode: ExitCode.Failure,
    });
  }
  return {
    bin,
    packageDir: dirname(bin),
    packageName: PI_PACKAGE,
    version: `unknown (global install; run \`${PRODUCT_NAME} pi --global-pi --version\`)`,
    source: "global",
  };
}

/** Minimal PATH lookup; avoids a dependency for the one place we need it. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env["PATH"] ?? "";
  const extensions = process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}

export interface RunPiOptions {
  paths: PiorbitPaths;
  global: boolean;
  cwd?: string;
  /** Streams to inherit. `"inherit"` in normal use; overridden by doctor. */
  stdio?: "inherit" | "pipe";
}

export interface PiRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run Pi and behave like a transparent wrapper: stdio is inherited so the TUI
 * works, the exit code is forwarded, and a child killed by a signal makes the
 * wrapper die of the same signal (so `$?` is 128+n and shells report it the way
 * they would for Pi itself). SIGINT is deliberately ignored in the wrapper: the
 * terminal already delivers it to the whole foreground group, and Pi wants to
 * handle its own Ctrl-C.
 */
export async function runPi(argv: readonly string[], options: RunPiOptions): Promise<PiRunResult> {
  const pi = options.global ? resolveGlobalPi() : resolvePinnedPi();
  const stdio = options.stdio ?? "inherit";
  const cwd = options.cwd ?? process.cwd();
  if (!existsSync(cwd)) {
    // Node reports a missing cwd as `spawn <node> ENOENT`, which sends people
    // looking for the wrong problem.
    throw new CliError(`cannot run Pi in ${cwd}: the directory does not exist`, {
      fix: "Run the command from a directory that exists, or pass an existing one.",
    });
  }
  const child = spawn(process.execPath, [pi.bin, ...argv], {
    stdio,
    cwd,
    env: piEnv(options.paths),
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const ignoreInt = () => {};
  const forward = (signal: NodeJS.Signals) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const forwarded: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGQUIT"];
  const handlers = forwarded.map((signal) => [signal, forward(signal)] as const);
  process.on("SIGINT", ignoreInt);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  try {
    return await new Promise<PiRunResult>((resolvePromise, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          new CliError(`could not run the ${pi.source} Pi at ${pi.bin}: ${error.message}`, {
            fix:
              pi.source === "pinned"
                ? `Run \`${PRODUCT_NAME} doctor\` — it checks that the pinned Pi resolves and boots.`
                : "Check that `pi` on your PATH is executable.",
            cause: error,
          }),
        ),
      );
      child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    });
  } finally {
    process.off("SIGINT", ignoreInt);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

/**
 * Exit this process the way the child exited, including by signal. Never
 * returns.
 */
export function exitLikeChild(result: PiRunResult): never {
  if (result.signal) {
    // `runPi` has already removed its handlers, so this takes the default
    // action and the shell sees the same status it would for Pi itself.
    process.kill(process.pid, result.signal);
    // Only reached if the signal is blocked or ignored by the parent shell.
    process.exit(128 + (signals[result.signal] ?? 0));
  }
  process.exit(result.code ?? 0);
}
