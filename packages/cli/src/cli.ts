/**
 * The router. Rules, in order:
 *
 *   laser                  → `up`
 *   laser --help|-h        → the command list
 *   laser --version|-V     → the version
 *   laser --<flag> …       → `up` with those flags (so `laser --no-open` works)
 *   laser <command> …      → that command
 *
 * The command name comes first; everything else is parsed from Laser's own
 * command table.
 */
import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { distance, parseArgs, type ParsedArgs } from "./args.js";
import { findCommand, type Command, type CommandContext } from "./command.js";
import { resolvePaths } from "./config.js";
import { CliError, ExitCode, messageOf, type ExitCodeValue } from "./errors.js";
import { colorMode, flagsFor, GLOBAL_FLAGS } from "./flags.js";
import { renderCommandHelp, renderRootHelp, TOPICS } from "./help.js";
import { sanitize, Terminal, type ColorMode } from "./output.js";
import { doctorCommand } from "./commands/doctor.js";
import { hostCommands } from "./commands/host.js";
import { logsCommand } from "./commands/logs.js";
import { metaCommands } from "./commands/meta.js";
import { projectsCommand } from "./commands/projects.js";
import { relayCommand } from "./commands/relay.js";
import { runsCommand } from "./commands/runs.js";
import { sessionCommands } from "./commands/session.js";
import { settingsCommand } from "./commands/settings.js";
import { CLI_VERSION } from "./version.js";

export const COMMANDS: readonly Command[] = [
  ...hostCommands,
  ...sessionCommands,
  runsCommand,
  projectsCommand,
  settingsCommand,
  relayCommand,
  doctorCommand,
  logsCommand,
  ...metaCommands,
];

export async function run(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  // Before parsing, a failure can still honour the two flags that decide how
  // it is *printed*. A wrapper that pipes stderr into a JSON parser breaks on
  // exactly the errors it is most likely to hit otherwise.
  const early = (tokens: readonly string[]): Terminal =>
    new Terminal({ json: earlyJson(tokens), color: earlyColor(tokens) });

  // `--help` with no command is the only help path handled here; `laser help`
  // is a real command, so it can honour --color and the rest.
  if (first === "--help" || first === "-h") {
    renderRootHelp(COMMANDS, new Terminal({ json: false, color: earlyColor(argv) }));
    return ExitCode.Ok;
  }
  if (first === "--version" || first === "-V") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return ExitCode.Ok;
  }

  // Global flags may lead (`laser --agent-dir /tmp/x status`). Anything that
  // is not a global flag ends the scan, so `laser --no-open` still means
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
        ...(suggest(name as string) ? { fix: `Did you mean \`${PRODUCT_NAME} ${suggest(name as string)}\`?` } : {}),
        details: [`Run \`${PRODUCT_NAME} --help\` for the full list.`],
      }),
      early(argv),
    );
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(rest, flagsFor(command.flags));
  } catch (error) {
    const term = early(rest);
    if (!term.json) term.note(term.err.dim(`usage: ${command.usage}`));
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
    // An error message routinely quotes the host, a tool result or a file the
    // agent named, so it is untrusted bytes like anything else that reaches a
    // terminal (render.ts). JSON above escapes control characters itself.
    process.stderr.write(`${p.red("error")} ${sanitize(message)}\n`);
    for (const line of cli?.details ?? []) process.stderr.write(`      ${p.dim(sanitize(line))}\n`);
    if (cli?.fix) process.stderr.write(`      ${p.dim(`→ ${sanitize(cli.fix)}`)}\n`);
  }

  if (!cli && process.env[ENV.debug] && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  return exitCode;
}

/**
 * `--color`/`--no-color` and `--json` read straight off `argv`, for the two
 * moments a failure can happen before the parser has run.
 */
function earlyColor(tokens: readonly string[], env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (tokens.includes("--no-color")) return "never";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const value = token.startsWith("--color=") ? token.slice("--color=".length) : token === "--color" ? tokens[i + 1] : undefined;
    if (value === "always" || value === "never" || value === "auto") return value;
  }
  return env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "" ? "never" : "auto";
}

function earlyJson(tokens: readonly string[]): boolean {
  return tokens.includes("--json") || tokens.includes("--json=true");
}
