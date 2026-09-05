/**
 * One description of a command, used four ways: to parse its arguments, to
 * print its `--help`, to generate shell completions, and to run it. Anything
 * that would have to be repeated across those four is a bug in this shape.
 */
import type { FlagSpecs, ParsedArgs } from "./args.js";
import type { PiorbitPaths } from "./config.js";
import type { Terminal } from "./output.js";

export type CommandGroup = "Host" | "Sessions" | "Projects" | "Relay" | "Pi" | "Diagnostics" | "Shell";

export interface PositionalSpec {
  name: string;
  description: string;
  optional?: boolean;
  /** Consumes the rest of the line (`piorbit send <text...>`). */
  variadic?: boolean;
}

export interface Example {
  command: string;
  note: string;
}

export interface CommandContext {
  term: Terminal;
  paths: PiorbitPaths;
  args: ParsedArgs;
  /** Argv after the command name, before parsing. Passthrough commands use it. */
  raw: readonly string[];
  /** Every command, for `help` and `completions`. */
  commands: readonly Command[];
}

export interface Command {
  name: string;
  aliases?: readonly string[];
  group: CommandGroup;
  /** One line, lower case, no trailing period. Shown in `piorbit --help`. */
  summary: string;
  usage: string;
  /** A paragraph or two for `piorbit <command> --help`. */
  description?: string;
  positionals?: readonly PositionalSpec[];
  flags?: FlagSpecs;
  examples?: readonly Example[];
  /**
   * Do not parse flags; hand everything after the command name to `run` as
   * `raw`. Used by `pi`, whose flags belong to Pi.
   */
  passthrough?: boolean;
  /** Kept out of `piorbit --help` and completions (`__daemon`). */
  hidden?: boolean;
  /** Return an exit code, or nothing for success. Throw `CliError` to fail. */
  run(context: CommandContext): Promise<number | void>;
}

export function findCommand(commands: readonly Command[], name: string): Command | undefined {
  return commands.find((command) => command.name === name || command.aliases?.includes(name));
}
