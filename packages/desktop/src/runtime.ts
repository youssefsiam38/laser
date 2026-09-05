/**
 * Finding the stock Node the host runs on (M5-T2).
 *
 * The rule this whole module exists to keep: **the host's `process.execPath`
 * must be a real node binary.** Pi spawns MCP servers and `npx` with it, and a
 * child that inherits an Electron execPath either refuses to start or starts a
 * second copy of the app. Electron's `runAsNode` fuse would paper over that,
 * but it also turns the shipped app into a general-purpose script runner, which
 * is a security hole we are not opening for a convenience we do not need.
 *
 * `utilityProcess` is the other tempting shortcut and is not usable either: it
 * gives the child no stdin, and the worker pipe needs one.
 *
 * So: ship a binary, run it, and check what it says about itself.
 */
import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NodeRuntime {
  binary: string;
  version: string;
  /** What the child reports as its own `process.execPath`. */
  execPath: string;
  /** Where it came from, for the log and for the settings screen. */
  source: "bundled" | "override" | "path";
  /**
   * The package manager staged beside it, when there is one.
   *
   * piorbit installs extensions from Settings, and the person who installed a
   * desktop app has no npm on PATH. `build/before-pack.cjs` stages the one that
   * ships inside the pinned Node archive next to the binary, so this is a
   * sibling lookup rather than a search: found here, or the app says installs
   * are unavailable and why, and never quietly reaches for the machine's own.
   */
  npmCli?: string;
}

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

const binaryName = process.platform === "win32" ? "node.exe" : "node";

/** Candidate binaries, best first. */
function candidates(options: { packaged: boolean; resourcesPath: string }): Array<{ path: string; source: NodeRuntime["source"] }> {
  const found: Array<{ path: string; source: NodeRuntime["source"] }> = [];

  const override = process.env[ENV.node];
  if (override) found.push({ path: override, source: "override" });

  if (options.packaged) {
    // electron-builder copies runtime/<platform>-<arch>/ to resources/runtime/,
    // outside app.asar — an archive is not something a kernel can execute.
    found.push({ path: join(options.resourcesPath, "runtime", binaryName), source: "bundled" });
    // …and nothing else. The whole claim of a packaged build is that it
    // resolves no runtime from the machine it lands on: an app that quietly
    // fell back to whatever `node` is on PATH would run the agent on an
    // unpinned version, and the person would never be told. If the bundled one
    // is missing the install is broken, and `resolveNodeRuntime` says exactly
    // that. `PIORBIT_NODE` above stays the deliberate override.
    return found;
  }

  const devRuntime = fileURLToPath(new URL("../runtime/", import.meta.url));
  found.push({ path: join(devRuntime, `${process.platform}-${process.arch}`, binaryName), source: "bundled" });
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir) found.push({ path: join(dir, binaryName), source: "path" });
  }
  return found;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the candidate and ask it who it is. This is the actual proof, rather than
 * trusting a filename: a `node` on PATH could be a shim, a wrapper script, or
 * Electron with the fuse on.
 */
export function probeNode(binary: string): { version: string; execPath: string; electron: boolean } | undefined {
  // Never inherit ELECTRON_RUN_AS_NODE: it is the one variable that would make
  // this probe lie, by turning an Electron binary into something that answers
  // like node.
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  const probe = spawnSync(
    binary,
    ["-p", "JSON.stringify({v:process.version,e:process.execPath,el:!!process.versions.electron})"],
    { encoding: "utf8", timeout: 20_000, env },
  );
  if (probe.status !== 0 || !probe.stdout) return undefined;
  try {
    const parsed = JSON.parse(probe.stdout.trim()) as { v: string; e: string; el: boolean };
    if (typeof parsed.v !== "string" || typeof parsed.e !== "string") return undefined;
    return { version: parsed.v, execPath: parsed.e, electron: Boolean(parsed.el) };
  } catch {
    return undefined;
  }
}

/**
 * The Node the host will be spawned from. Throws a `RuntimeError` whose
 * `message` says what is missing and whose `fix` says what to do about it —
 * both are shown to the person, so neither may be a stack trace.
 */
export function resolveNodeRuntime(options: { packaged: boolean; resourcesPath: string }): NodeRuntime {
  const tried: string[] = [];
  for (const candidate of candidates(options)) {
    if (!existsSync(candidate.path) || !isExecutable(candidate.path)) continue;
    tried.push(candidate.path);
    const report = probeNode(candidate.path);
    if (!report) continue;
    if (report.electron) continue; // Electron pretending to be node: exactly what we must not use.
    const npmCli = join(dirname(candidate.path), "npm", "bin", "npm-cli.js");
    return {
      binary: candidate.path,
      version: report.version,
      execPath: report.execPath,
      source: candidate.source,
      ...(existsSync(npmCli) ? { npmCli } : {}),
    };
  }

  if (options.packaged) {
    throw new RuntimeError(
      `${PRODUCT_NAME} could not find the Node runtime it ships with, so it cannot start the agent host.`,
      `This install is incomplete. Reinstall ${PRODUCT_NAME}; if it happens again, please report it with the log above.`,
    );
  }
  throw new RuntimeError(
    tried.length > 0
      ? `None of these ran as a plain Node: ${tried.join(", ")}.`
      : "No Node runtime was found for the development build.",
    `Run \`pnpm -F @lasercode/desktop runtime\` to download the pinned Node, or set ${ENV.node} to a node binary.`,
  );
}
