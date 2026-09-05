/**
 * The router. Rules, in order:
 *
 *   piorbit                  → `up`
 *   piorbit --help|-h        → the command list
 *   piorbit --version|-V     → the version
 *   piorbit --<flag> …       → `up` with those flags (so `piorbit --no-open` works)
 *   piorbit <command> …      → that command
 *
 * The command name comes first. That is what makes `piorbit pi --help` reach
 * Pi rather than piorbit: once the name is read, a passthrough command owns
 * every remaining token.
 */
import { distance, parseArgs, type ParsedArgs } from "./args.js";
import { findCommand, type Command, type CommandContext } from "./command.js";
import { resolvePaths } from "./config.js";
import { CliError, ExitCode, messageOf, type ExitCodeValue } from "./errors.js";
import { colorMode, flagsFor, GLOBAL_FLAGS } from "./flags.js";
import { renderCommandHelp, renderRootHelp, TOPICS } from "./help.js";
import { Terminal } from "./output.js";
import { doctorCommand } from "./commands/doctor.js";
import { hostCommands } from "./commands/host.js";
import { logsCommand } from "./commands/logs.js";
import { metaCommands } from "./commands/meta.js";
import { packagesCommand } from "./commands/packages.js";
import { piCommand } from "./commands/pi.js";
import { projectsCommand } from "./commands/projects.js";
import { sessionCommands } from "./commands/session.js";
import { settingsCommand } from "./commands/settings.js";
import { CLI_VERSION } from "./version.js";

export const COMMANDS: readonly Command[] = [
  ...hostCommands,
  ...sessionCommands,
  projectsCommand,
  settingsCommand,
  packagesCommand,
  piCommand,
  doctorCommand,
  logsCommand,
  ...metaCommands,
];

const EMPTY_ARGS: ParsedArgs = { flags: {}, positionals: [], rest: [], hasRest: false };

export async function run(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  // `--help` with no command is the only help path handled here; `piorbit help`
  // is a real command, so it can honour --color and the rest.
  if (first === "--help" || first === "-h") {
    renderRootHelp(COMMANDS, new Terminal({ json: false, color: "auto" }));
    return ExitCode.Ok;
  }
  if (first === "--version" || first === "-V") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return ExitCode.Ok;
  }

  // Global flags may lead (`piorbit --agent-dir /tmp/x status`). Anything that
  // is not a global flag ends the scan, so `piorbit --no-open` still means
  // `up --no-open` rather than an error about an unknown global.
  const { leading, index } = scanLeadingGlobals(argv);
  const name = argv[index];
  const named = name !== undefined && !name.startsWith("-");
  const command = named ? findCommand(COMMANDS, name) : findCommand(COMMANDS, "up");
  const rest = named ? [...leading, ...argv.slice(index + 1)] : argv;

  if (!command) {
    return fail(
      new CliError(`unknown command ${JSON.stringify(name)}`, {
        exitCode: ExitCode.Usage,
        ...(suggest(name as string) ? { fix: `Did you mean \`piorbit ${suggest(name as string)}\`?` } : {}),
        details: ["Run `piorbit --help` for the full list."],
      }),
      new Terminal({ json: false, color: "auto" }),
    );
  }

  if (command.passthrough) {
    // No parsing at all: the command owns its arguments, including --help.
    const term = new Terminal({ json: false, color: "auto" });
    try {
      const stray = leading.find((token) => token.startsWith("-") && !isPiPrefixFlag(token));
      if (stray) {
        throw new CliError(`${stray} cannot be used before \`piorbit ${command.name}\``, {
          exitCode: ExitCode.Usage,
          fix: `Everything after \`${command.name}\` goes to Pi. Only ${[...PI_PREFIX_FLAGS].join(", ")} are piorbit's there.`,
        });
      }
      const result = await command.run({
        term,
        paths: resolvePaths(EMPTY_ARGS),
        args: EMPTY_ARGS,
        raw: rest,
        commands: COMMANDS,
      });
      return typeof result === "number" ? result : ExitCode.Ok;
    } catch (error) {
      return fail(error, term);
    }
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(rest, flagsFor(command.flags));
  } catch (error) {
    const term = new Terminal({ json: false, color: "auto" });
    term.note(term.err.dim(`usage: ${command.usage}`));
    return fail(error, term);
  }

  const term = new Terminal({ json: args.flags["json"] === true, color: colorMode(args) });

  if (args.flags["help"] === true) {
    renderCommandHelp(command, term);
    return ExitCode.Ok;
  }

  try {
    const context: CommandContext = {
      term,
      paths: resolvePaths(args),
      args,
      raw: rest,
      commands: COMMANDS,
    };
    const result = await command.run(context);
    return typeof result === "number" ? result : ExitCode.Ok;
  } catch (error) {
    return fail(error, term);
  }
}

/**
 * Consume leading global flags so they may appear before the command name.
 * Returns them and the index of the first token that is not one — the command
 * name, or something `up` should deal with.
 */
export function scanLeadingGlobals(argv: readonly string[]): { leading: string[]; index: number } {
  const leading: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] as string;
    if (token === "--" || !token.startsWith("-") || token === "-") break;

    const eq = token.indexOf("=");
    const bare = (eq >= 0 ? token.slice(0, eq) : token).replace(/^--?/, "");
    const negated = bare.startsWith("no-") ? bare.slice(3) : undefined;
    const spec =
      GLOBAL_FLAGS[bare] ??
      (negated && GLOBAL_FLAGS[negated]?.type === "boolean" ? GLOBAL_FLAGS[negated] : undefined) ??
      Object.values(GLOBAL_FLAGS).find((candidate) => candidate.short !== undefined && candidate.short === bare);
    if (!spec) break;

    leading.push(token);
    i += 1;
    if (spec.type !== "boolean" && eq < 0 && !negated) {
      const value = argv[i];
      if (value === undefined) break;
      leading.push(value);
      i += 1;
    }
  }
  return { leading, index: i };
}

/** Flags `piorbit pi` will consume before handing the rest to Pi. */
const PI_PREFIX_FLAGS = new Set(["--global-pi", "--agent-dir", "--session-dir", "--subagents-temp-root"]);

function isPiPrefixFlag(token: string): boolean {
  const eq = token.indexOf("=");
  return PI_PREFIX_FLAGS.has(eq >= 0 ? token.slice(0, eq) : token);
}

/** Closest command or topic name, for "did you mean". */
function suggest(input: string): string | undefined {
  const bare = input.replace(/^-+/, "");
  const candidates = [
    ...COMMANDS.filter((command) => !command.hidden).flatMap((command) => [command.name, ...(command.aliases ?? [])]),
    ...TOPICS.map((topic) => topic.name),
  ];
  const best = candidates
    .map((name) => ({ name, d: distance(bare, name) }))
    .sort((a, b) => a.d - b.d)
    .find((entry) => entry.d <= Math.max(2, Math.floor(entry.name.length / 3)));
  return best?.name;
}

/**
 * One place that prints a failure. Human mode gets a message, context and a fix
 * on stderr; `--json` gets the same thing as a JSON object on stderr, so a
 * script can read the fix too.
 */
function fail(error: unknown, term: Terminal): ExitCodeValue {
  const cli = error instanceof CliError ? error : undefined;
  const exitCode = cli?.exitCode ?? ExitCode.Failure;
  const message = messageOf(error);

  if (term.json) {
    process.stderr.write(
      `${JSON.stringify({
        error: {
          message,
          ...(cli?.details.length ? { details: cli.details } : {}),
          ...(cli?.fix ? { fix: cli.fix } : {}),
          exitCode,
        },
      })}\n`,
    );
  } else {
    const p = term.err;
    process.stderr.write(`${p.red("error")} ${message}\n`);
    for (const line of cli?.details ?? []) process.stderr.write(`      ${p.dim(line)}\n`);
    if (cli?.fix) process.stderr.write(`      ${p.dim(`→ ${cli.fix}`)}\n`);
  }

  if (!cli && process.env["PIORBIT_DEBUG"] && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  return exitCode;
}
