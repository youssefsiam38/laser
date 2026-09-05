/**
 * Flags every command accepts. Kept in one place so `--json` really does mean
 * the same thing everywhere, which is the only reason `--json` is worth having.
 */
import type { FlagSpecs, ParsedArgs } from "./args.js";
import { bool, str } from "./args.js";
import { PATH_FLAGS, PORT_FLAG } from "./config.js";
import type { ColorMode } from "./output.js";

export const GLOBAL_FLAGS: FlagSpecs = {
  help: { type: "boolean", short: "h", description: "Show help for this command" },
  json: { type: "boolean", description: "Print the result as JSON on stdout (errors stay on stderr)" },
  color: {
    type: "string",
    description: "When to colourise output",
    placeholder: "<auto|always|never>",
    choices: ["auto", "always", "never"],
    default: "auto",
  },
  "no-color": { type: "boolean", description: "Same as --color never", hidden: true },
  ...PORT_FLAG,
  ...PATH_FLAGS,
};

export function colorMode(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (bool(parsed, "no-color")) return "never";
  const value = str(parsed, "color");
  if (value === "always" || value === "never" || value === "auto") return value;
  return env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "" ? "never" : "auto";
}

/** Merge a command's own flags with the global ones. Command flags win. */
export function flagsFor(commandFlags: FlagSpecs | undefined): FlagSpecs {
  return { ...GLOBAL_FLAGS, ...commandFlags };
}
