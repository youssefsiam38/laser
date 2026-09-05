/**
 * `piorbit pi ...` — the pinned Pi, with piorbit's environment.
 *
 * This command is deliberately transparent. Everything after `pi` belongs to
 * Pi: `--help`, `--version`, `update --extensions`, `models`, any future verb.
 * piorbit consumes only the flags that appear *before* Pi's first argument, so
 * there is one simple rule to remember and no flag can ever be shadowed.
 */
import type { ParsedArgs } from "../args.js";
import type { Command } from "../command.js";
import { resolvePaths } from "../config.js";
import { usageError } from "../errors.js";
import { exitLikeChild, runPi } from "../pi.js";

/** Flags piorbit will eat if they lead; everything after the first miss is Pi's. */
const BOOLEAN_PREFIX = new Set(["--global-pi"]);
const VALUE_PREFIX = new Set(["--agent-dir", "--session-dir", "--subagents-temp-root"]);

export interface PiPrefix {
  global: boolean;
  overrides: Record<string, string>;
  /** Arguments to hand to Pi, verbatim. */
  rest: string[];
}

/**
 * Split `piorbit pi` arguments into piorbit's leading flags and Pi's arguments.
 * Exported because the rule is subtle enough to deserve a test.
 */
export function splitPiArgs(raw: readonly string[]): PiPrefix {
  const overrides: Record<string, string> = {};
  let global = false;
  const queue = [...raw];

  while (queue.length > 0) {
    const token = queue[0] as string;
    if (token === "--") {
      // An explicit terminator: everything after it is Pi's, even our flags.
      queue.shift();
      break;
    }
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;

    if (BOOLEAN_PREFIX.has(name)) {
      if (inline !== undefined) throw usageError(`${name} is a switch; it does not take a value`);
      global = true;
      queue.shift();
      continue;
    }
    if (VALUE_PREFIX.has(name)) {
      queue.shift();
      const value = inline ?? queue.shift();
      if (value === undefined) throw usageError(`${name} expects a directory`, `Write it as \`${name} <dir>\`.`);
      overrides[name.slice(2)] = value;
      continue;
    }
    break;
  }

  return { global, overrides, rest: queue };
}

export const piCommand: Command = {
  name: "pi",
  group: "Pi",
  passthrough: true,
  summary: "run the Pi that piorbit pins, with piorbit's agent directory",
  usage: "piorbit pi [--global-pi] [--agent-dir <dir>] [-- ] <pi arguments...>",
  description: `
Runs the exact Pi that @piorbit/worker pins — the same copy the app runs — with
PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR and PI_SUBAGENTS_TEMP_ROOT set
to piorbit's. A session or a background subagent run you start this way is
visible in the app.

Everything after \`pi\` goes to Pi untouched, including --help and --version.
piorbit only consumes the flags below, and only while they lead. Use \`--\` to
pass one of them through to Pi instead.

stdio is inherited, so the TUI works. Pi's exit code is this command's exit
code, and a Pi killed by a signal kills this wrapper with the same signal.
`,
  positionals: [{ name: "pi arguments...", description: "Passed to Pi verbatim", optional: true, variadic: true }],
  flags: {
    "global-pi": { type: "boolean", description: "Use the `pi` on your PATH instead of the pinned one" },
  },
  examples: [
    { note: "Pi's own help, from the pinned copy", command: "piorbit pi --help" },
    { note: "update Pi's installed extensions", command: "piorbit pi update --extensions" },
    { note: "one-shot prompt in this directory", command: 'piorbit pi -p "summarise the diff"' },
  ],
  async run({ raw }) {
    const { global, overrides, rest } = splitPiArgs(raw);
    const parsed: ParsedArgs = {
      flags: overrides,
      positionals: [],
      rest: [],
      hasRest: false,
    };
    const paths = resolvePaths(parsed);
    const result = await runPi(rest, { paths, global });
    exitLikeChild(result);
  },
};
