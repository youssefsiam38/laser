#!/usr/bin/env node
/**
 * `pnpm tool-eval` — the evaluation harness, run by hand.
 *
 * Two modes, and the difference between them is the point:
 *
 *   - **Recorded** (the default). No network, no model, no credential: every
 *     fixture is replayed through the real engine against its recorded
 *     provider responses, on every profile the fixture settings file
 *     configures. This is what the test suite runs, and what proves a tool's
 *     schema, refusals and narrowing did not change.
 *   - **Live** (`--live`). The person starts it themselves. It uses their own
 *     profiles, providers and models: a real model is given each fixture's
 *     task and chooses the calls itself, in a throwaway project directory,
 *     against the same scripted world — so nothing real is started, stopped
 *     or removed. It is never run by the test suite and never by `pnpm
 *     verify`, because it spends the person's own credit.
 *
 * Usage:
 *
 *   pnpm tool-eval                          # every fixture, every fixture profile
 *   pnpm tool-eval --tool inspect_agent     # one tool
 *   pnpm tool-eval --live --profile Fast    # the person's own profile, live
 *   pnpm tool-eval --out report.json        # write the machine-readable report
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { loadFixtures } from "./fixture.js";
import { evaluateFixtures, profilesFrom } from "./harness.js";
import { reportTable } from "./report.js";

interface Options {
  live: boolean;
  profile?: string;
  tool?: string;
  fixtures: string;
  /** The directory whose settings.json holds the profile matrix. */
  profilesDir: string;
  out?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** `dist/tool-eval` and `src/tool-eval` are both two levels under the package. */
const packageRoot = resolve(here, "..", "..");
const DEFAULT_FIXTURES = join(packageRoot, "test", "fixtures", "tool-eval");
const DEFAULT_PROFILES = join(DEFAULT_FIXTURES, "profiles");

/** Where this installation keeps its agent directory, for a live run. */
function personAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["PI_CODING_AGENT_DIR"];
  if (explicit && explicit.trim() !== "") return explicit;
  const home = env["HOME"] ?? homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", DATA_DIR_NAME, "agent");
  if (process.platform === "win32") {
    const base = env["LOCALAPPDATA"] ?? env["APPDATA"] ?? join(home, "AppData", "Local");
    return join(base, DATA_DIR_NAME, "agent");
  }
  const xdg = env["XDG_DATA_HOME"];
  return join(xdg && xdg.trim() !== "" ? xdg : join(home, ".local", "share"), DATA_DIR_NAME, "agent");
}

function parse(argv: string[]): Options {
  const options: Options = { live: false, fixtures: DEFAULT_FIXTURES, profilesDir: DEFAULT_PROFILES };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]!;
    const value = (): string => {
      const next = argv[at + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      at += 1;
      return next;
    };
    switch (arg) {
      case "--live":
        options.live = true;
        break;
      case "--profile":
        options.profile = value();
        break;
      case "--tool":
        options.tool = value();
        break;
      case "--fixtures":
        options.fixtures = absolute(value());
        break;
      case "--profiles":
        options.profilesDir = absolute(value());
        break;
      case "--agent-dir":
        process.env["PI_CODING_AGENT_DIR"] = absolute(value());
        break;
      case "--out":
        options.out = absolute(value());
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`${arg} is not an option this command takes.\n\n${usage()}`);
    }
  }
  return options;
}

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(process.cwd(), path));

function usage(): string {
  return [
    "tool-eval — run every tool's conformance fixture on every configured profile.",
    "",
    "  --live               use the real profiles, providers and models of this installation",
    "  --profile <name>     only this profile (by name or id)",
    "  --tool <name>        only this tool's fixture",
    "  --fixtures <dir>     where the fixtures are (default: the package's own)",
    "  --profiles <dir>     the directory whose settings.json holds the profile matrix",
    "  --agent-dir <dir>    the agent directory a live run reads providers from",
    "  --out <file>         write the JSON report here as well as the table",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (!existsSync(options.fixtures)) throw new Error(`There are no fixtures at ${options.fixtures}.`);
  const all = loadFixtures(options.fixtures);
  const fixtures = options.tool === undefined ? all : all.filter((fixture) => fixture.tool === options.tool);
  if (fixtures.length === 0) throw new Error(`No fixture is written for "${options.tool ?? ""}". The fixtures cover: ${all.map((fixture) => fixture.tool).join(", ")}.`);

  const agentDir = options.live ? personAgentDir() : undefined;
  const profilesDir = options.live ? agentDir! : options.profilesDir;
  if (!existsSync(join(profilesDir, "settings.json"))) {
    throw new Error(
      options.live
        ? `${PRODUCT_DISPLAY_NAME} has no settings at ${profilesDir}. Open the app once, or pass --agent-dir.`
        : `The profile matrix needs a settings.json at ${profilesDir}.`,
    );
  }
  const profiles = profilesFrom(profilesDir, options.profile);

  process.stdout.write(`${String(fixtures.length)} fixtures × ${String(profiles.length)} profiles, ${options.live ? "live" : "recorded"}\n`);
  const report = await evaluateFixtures({
    fixtures,
    profiles,
    ...(agentDir !== undefined ? { liveAgentDir: agentDir } : {}),
    onResult: (result) => {
      process.stdout.write(`  ${result.pass ? "ok" : "XX"}  ${result.profile.name} · ${result.tool}\n`);
    },
  });
  process.stdout.write(`\n${reportTable(report)}\n`);
  if (options.out !== undefined) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nReport written to ${options.out}\n`);
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
