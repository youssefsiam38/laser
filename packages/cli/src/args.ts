/**
 * The argument parser. Hand-rolled on purpose: the CLI's whole dependency
 * budget is `ws`, and a spec-driven parser is what makes `--help`, shell
 * completions and "did you mean" all fall out of one table.
 *
 * Supported forms:
 *   --flag                 boolean on
 *   --no-flag              boolean off (any boolean flag, automatically)
 *   --flag value           string / number
 *   --flag=value           string / number (and `--flag=true|false` for booleans)
 *   -f value               short form
 *   -abc                   grouped short booleans (a value-taking short must be last)
 *   --                     stop parsing; the rest is verbatim
 *   -                      a positional (stdin convention), never a flag
 */
import { usageError } from "./errors.js";

export type FlagType = "boolean" | "string" | "number";

export interface FlagSpec {
  type: FlagType;
  /** Single-letter alias, without the dash. */
  short?: string;
  description: string;
  /** Value name in help, e.g. `<port>`. Defaults to `<value>`. */
  placeholder?: string;
  /** Collect every occurrence instead of last-wins. String flags only. */
  repeat?: boolean;
  default?: boolean | string | number;
  /** Kept out of `--help` but still accepted (internal plumbing). */
  hidden?: boolean;
  /** Fixed set of accepted values; used for completions and validation. */
  choices?: readonly string[];
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export type FlagValue = boolean | string | number | string[];

export interface ParsedArgs {
  readonly flags: Readonly<Record<string, FlagValue | undefined>>;
  readonly positionals: readonly string[];
  /** Everything after a bare `--`, unparsed. */
  readonly rest: readonly string[];
  /** True when `--` appeared, even with nothing after it. */
  readonly hasRest: boolean;
}

export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const flags: Record<string, FlagValue | undefined> = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  let hasRest = false;

  for (const [name, spec] of Object.entries(specs)) {
    if (spec.default !== undefined) flags[name] = spec.default;
  }

  const shorts = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.short) shorts.set(spec.short, name);
  }

  const setValue = (name: string, spec: FlagSpec, raw: string): void => {
    if (spec.choices && !spec.choices.includes(raw)) {
      throw usageError(
        `--${name} does not accept ${JSON.stringify(raw)}`,
        `Use one of: ${spec.choices.join(", ")}`,
      );
    }
    if (spec.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw usageError(`--${name} expects a number, got ${JSON.stringify(raw)}`);
      flags[name] = value;
      return;
    }
    if (spec.repeat) {
      const current = flags[name];
      flags[name] = Array.isArray(current) ? [...current, raw] : [raw];
      return;
    }
    flags[name] = raw;
  };

  const takeValue = (name: string, spec: FlagSpec, inline: string | undefined, queue: string[]): void => {
    if (inline !== undefined) {
      setValue(name, spec, inline);
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      throw usageError(`--${name} expects ${spec.placeholder ?? "a value"}`, `Write it as \`--${name} <value>\`.`);
    }
    setValue(name, spec, next);
  };

  const queue = [...argv];
  while (queue.length > 0) {
    const token = queue.shift() as string;

    if (token === "--") {
      hasRest = true;
      rest.push(...queue.splice(0));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const raw = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const inline = eq >= 0 ? token.slice(eq + 1) : undefined;

      const negated = raw.startsWith("no-") ? raw.slice(3) : undefined;
      if (negated && specs[negated]?.type === "boolean") {
        if (inline !== undefined) throw usageError(`--no-${negated} does not take a value`);
        flags[negated] = false;
        continue;
      }

      const spec = specs[raw];
      if (!spec) throw unknownFlag(`--${raw}`, specs);
      if (spec.type === "boolean") {
        if (inline === undefined) flags[raw] = true;
        else if (inline === "true" || inline === "false") flags[raw] = inline === "true";
        else throw usageError(`--${raw} is a switch; it does not take ${JSON.stringify(inline)}`);
        continue;
      }
      takeValue(raw, spec, inline, queue);
      continue;
    }

    // Short forms. `-abc` groups booleans; a value-taking short must be last.
    const group = token.slice(1);
    const eq = group.indexOf("=");
    const letters = eq >= 0 ? group.slice(0, eq) : group;
    const inline = eq >= 0 ? group.slice(eq + 1) : undefined;
    for (let i = 0; i < letters.length; i++) {
      const letter = letters[i] as string;
      const name = shorts.get(letter);
      const spec = name ? specs[name] : undefined;
      if (!name || !spec) throw unknownFlag(`-${letter}`, specs);
      if (spec.type === "boolean") {
        if (inline !== undefined && i === letters.length - 1) {
          if (inline !== "true" && inline !== "false") throw usageError(`-${letter} is a switch; it does not take a value`);
          flags[name] = inline === "true";
        } else {
          flags[name] = true;
        }
        continue;
      }
      if (i !== letters.length - 1) {
        throw usageError(
          `-${letter} expects a value, so it cannot sit inside the group ${token}`,
          `Write it last, or on its own: \`-${letter} <value>\`.`,
        );
      }
      takeValue(name, spec, inline, queue);
    }
  }

  return { flags, positionals, rest, hasRest };
}

function unknownFlag(flag: string, specs: FlagSpecs): Error {
  const bare = flag.replace(/^-+/, "");
  const known = Object.entries(specs)
    .filter(([, spec]) => !spec.hidden)
    .map(([name]) => name);
  const near = known
    .map((name) => ({ name, distance: distance(bare, name) }))
    .filter(({ name, distance: d }) => d <= 2 || name.startsWith(bare) || bare.startsWith(name))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ name }) => `--${name}`);
  return usageError(
    `unknown option ${flag}`,
    near.length > 0 ? `Did you mean ${near.join(" or ")}?` : "Run the command with --help to see its options.",
  );
}

/** Levenshtein distance, used only for "did you mean" suggestions. */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

// ---------------------------------------------------------------- accessors

export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function str(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function num(parsed: ParsedArgs, name: string): number | undefined {
  const value = parsed.flags[name];
  return typeof value === "number" ? value : undefined;
}

export function list(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags[name];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}
