/**
 * `piorbit settings` — read and write Pi settings from a terminal (M9-T5).
 *
 * The adapter lives in the worker (only it may import Pi), so every verb here
 * is one `pi/settings/*` call against the host, which starts or reuses the
 * worker for the project. That means `piorbit settings` and the Settings screen
 * cannot disagree: same lock, same merge rule, same trust answer.
 *
 * Values are JSON. `--raw` accepts a bare string for the common case
 * (`piorbit settings set theme --raw dark`) so nobody has to quote `'"dark"'`.
 */
import { resolve } from "node:path";
import type { SettingChange, SettingDescriptor, SettingsScope, SettingsSnapshot } from "@piorbit/protocol";
import { bool, str } from "../args.js";
import type { Command, CommandContext } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { clip, shortCwd } from "../format.js";
import { sanitize, table } from "../output.js";
import { describeRpcError, type HostRpc } from "../rpc.js";
import { connectForProject } from "./host.js";

const VERBS = ["get", "list", "set", "unset"] as const;
type Verb = (typeof VERBS)[number];

function verbOf(positionals: readonly string[]): { verb: Verb; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first === undefined) return { verb: "get", rest: [] };
  if ((VERBS as readonly string[]).includes(first)) return { verb: first as Verb, rest };
  // `piorbit settings theme` reads one key: the common case should not need a verb.
  return { verb: "get", rest: [first, ...rest] };
}

function scopeOf(args: CommandContext["args"]): SettingsScope {
  const value = str(args, "scope") ?? "global";
  // `piorbit packages` calls the same file "user". Accepting both spellings
  // costs nothing and saves the guess; the docs name "global".
  if (value === "user") return "global";
  if (value !== "global" && value !== "project") {
    throw new CliError(`unknown settings scope ${JSON.stringify(value)}`, {
      exitCode: ExitCode.Usage,
      fix: "Use --scope global (the default; `user` is accepted too) or --scope project.",
    });
  }
  return value;
}

/**
 * Dotted paths that a settings file sets but the catalogue does not describe.
 * Only whole top-level keys are considered unknown: a catalogue field like
 * `retry.provider.maxAttempts` means `retry` is known even though the top-level
 * key itself is not a field.
 */
function unknownKeys(snapshot: SettingsSnapshot, known: ReadonlySet<string>): string[] {
  const prefixes = new Set<string>();
  for (const path of known) prefixes.add(path.split(".")[0] as string);
  const out = new Set<string>();
  for (const doc of [snapshot.global.values, snapshot.project.values]) {
    for (const key of Object.keys(doc)) if (!prefixes.has(key)) out.add(key);
  }
  return [...out].sort();
}

async function snapshotOf(rpc: HostRpc, cwd: string): Promise<SettingsSnapshot> {
  const { snapshot } = await rpc.request("pi/settings/get", { cwd }).catch((error: unknown) => {
    throw describeRpcError(error, `could not read settings for ${cwd}`);
  });
  return snapshot;
}

/** Walk a dotted path through a plain object without touching prototypes. */
function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let node: unknown = doc;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function render(value: unknown): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Where an effective value comes from, which is the question people actually ask. */
function origin(snapshot: SettingsSnapshot, path: string): string {
  if (valueAt(snapshot.project.values, path) !== undefined) return "project";
  if (valueAt(snapshot.global.values, path) !== undefined) return "global";
  return "default";
}

export const settingsCommand: Command = {
  name: "settings",
  group: "Projects",
  summary: "read and write Pi settings for a project",
  usage: "piorbit settings [get [key]|list|set <key> <json>|unset <key>] [--project <dir>] [--scope <global|project>]",
  description: `
Reads the effective settings for a project — Pi's global file deep-merged with
that project's own \`.pi/settings.json\` — and writes either scope through Pi's
own lock, so a running session picks the change up.

Values are JSON: \`piorbit settings set compaction.reserveTokens 8192\`,
\`piorbit settings set hideThinkingBlock true\`. Use --raw for a plain string.

Writing project settings *creates* a trust-gated file. If the project is not
trusted, Pi will ignore what you just wrote — this command says so rather than
letting the write quietly do nothing.
`,
  positionals: [
    { name: "verb", description: "get (default), list, set, unset — or a key to read", optional: true },
    { name: "key", description: "Dotted setting path, e.g. compaction.reserveTokens", optional: true },
    { name: "value", description: "With `set`: the new value, as JSON", optional: true },
  ],
  flags: {
    project: { type: "string", short: "P", description: "Project directory (default: the current one)", placeholder: "<dir>" },
    scope: {
      type: "string",
      description: "Which file to write (`user` is accepted as a synonym for `global`)",
      placeholder: "<global|project>",
      choices: ["global", "user", "project"],
      default: "global",
    },
    raw: { type: "boolean", description: "With `set`: treat the value as a plain string, not JSON" },
    all: { type: "boolean", description: "With `list`: include every setting, not just the ones a file sets" },
  },
  examples: [
    { note: "everything in effect here", command: "piorbit settings" },
    { note: "one key, and where it comes from", command: "piorbit settings theme" },
    { note: "change a global setting", command: "piorbit settings set compaction.reserveTokens 8192" },
    { note: "back to Pi's default", command: "piorbit settings unset compaction.reserveTokens" },
  ],
  async run({ term, paths, args }) {
    const { verb, rest } = verbOf(args.positionals);
    const cwd = resolve(str(args, "project") ?? process.cwd());
    // Touching settings starts a worker for `cwd`; an untrusted project would
    // otherwise leave this command waiting on a question only the UI can answer.
    const rpc = await connectForProject(paths, cwd);
    try {
      if (verb === "get" || verb === "list") {
        const snapshot = await snapshotOf(rpc, cwd);
        const key = verb === "get" ? rest[0] : undefined;

        if (key !== undefined) {
          const value = valueAt(snapshot.effective, key);
          if (term.json) {
            term.data({ cwd, key, value, origin: origin(snapshot, key), projectTrust: snapshot.projectTrust });
            return;
          }
          if (value === undefined) {
            term.note(`${term.err.dim(key)} is not set; Pi's own default applies`);
            term.note();
            term.note(`  See what is set with ${term.err.bold("piorbit settings list")}`);
            return;
          }
          term.print(render(value));
          term.note(term.err.dim(`from ${origin(snapshot, key)} settings`));
          return;
        }

        // Rows come from the catalogue, so a key here is a key `settings set`
        // takes. Listing the files' top-level keys instead printed
        // `compaction {"reserveTokens":8192,…}` — unreadable, and not a path
        // any other verb accepts.
        const showAll = bool(args, "all");
        const catalog = await catalogOf(rpc, cwd);
        const known = new Set(catalog.map((field) => field.path));
        const rows = catalog
          .map((field) => ({
            path: field.path,
            value: valueAt(snapshot.effective, field.path),
            origin: origin(snapshot, field.path),
          }))
          .filter((row) => showAll || row.origin !== "default")
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        // Anything a file sets that this Pi has no field for: worth showing, and
        // worth marking, rather than silently dropping.
        const extra = unknownKeys(snapshot, known).map((path) => ({
          path,
          value: valueAt(snapshot.effective, path),
          origin: `${origin(snapshot, path)} (not a Pi setting)`,
        }));
        rows.push(...extra);

        if (term.json) {
          term.data({ cwd, settings: rows, snapshot });
          return;
        }
        term.note(`${term.err.bold(shortCwd(cwd))} ${term.err.dim(`· global ${snapshot.global.path}`)}`);
        if (!snapshot.projectTrust.trusted) term.warn(sanitize(snapshot.projectTrust.reason));
        if (snapshot.global.error) term.warn(`global settings: ${sanitize(snapshot.global.error)}`);
        if (snapshot.project.error) term.warn(`project settings: ${sanitize(snapshot.project.error)}`);
        if (rows.length === 0) {
          term.note("no settings are set; every value is Pi's default");
          return;
        }
        for (const line of table(
          rows,
          [
            { header: "setting", get: (row) => row.path },
            { header: "value", get: (row) => clip(sanitize(render(row.value)), 60) },
            { header: "from", get: (row) => row.origin },
          ],
          term.out,
        )) {
          term.print(line);
        }
        return;
      }

      // ---- writes ----
      const scope = scopeOf(args);
      const key = rest[0];
      if (!key) {
        throw new CliError(`\`settings ${verb}\` needs a key`, {
          exitCode: ExitCode.Usage,
          fix: `Write it as \`piorbit settings ${verb} <key>${verb === "set" ? " <value>" : ""}\`. \`piorbit settings list\` shows the keys.`,
        });
      }

      let change: SettingChange;
      if (verb === "unset") {
        change = { path: key, op: "unset" };
      } else {
        const raw = rest.slice(1).join(" ");
        if (raw === "") {
          throw new CliError("`settings set` needs a value", {
            exitCode: ExitCode.Usage,
            fix: `Write it as \`piorbit settings set ${key} <value>\` — JSON, or any text with --raw.`,
          });
        }
        change = { path: key, op: "set", value: bool(args, "raw") ? raw : parseJson(key, raw) };
      }

      if (scope === "project") {
        const before = await snapshotOf(rpc, cwd);
        if (!before.projectTrust.writable) {
          throw new CliError(`piorbit will not write project settings for ${cwd}`, {
            exitCode: ExitCode.HostError,
            fix: `${before.projectTrust.reason} Trust it with \`piorbit projects trust ${cwd}\`, or write the global scope instead.`,
          });
        }
      }

      const { snapshot } = await rpc
        .request("pi/settings/set", { cwd, scope, changes: [change] })
        .catch((error: unknown) => {
          throw describeRpcError(error, `could not write ${key}`);
        });

      if (term.json) {
        term.data({ cwd, scope, change, value: valueAt(snapshot.effective, key), snapshot });
        return;
      }
      const now = valueAt(snapshot.effective, key);
      term.note(
        verb === "unset"
          ? `${term.err.green("unset")} ${key} in ${scope} settings${now === undefined ? "" : term.err.dim(` (now ${render(now)} from ${origin(snapshot, key)})`)}`
          : `${term.err.green("set")} ${key} = ${sanitize(render(now))} ${term.err.dim(`in ${scope} settings`)}`,
      );
      // The write landed but Pi will ignore it: say so where it cannot be missed.
      if (scope === "project" && !snapshot.projectTrust.trusted) {
        term.warn(sanitize(snapshot.projectTrust.reason));
      }
    } finally {
      rpc.close();
    }
  },
};

async function catalogOf(rpc: HostRpc, cwd: string): Promise<SettingDescriptor[]> {
  const { catalog } = await rpc.request("pi/settings/list", { cwd }).catch((error: unknown) => {
    throw describeRpcError(error, "could not read the settings catalogue");
  });
  return catalog.fields;
}

function parseJson(key: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${JSON.stringify(raw)} is not valid JSON`, {
      exitCode: ExitCode.Usage,
      fix: `Quote strings (\`piorbit settings set ${key} '"value"'\`) or pass --raw to take it literally.`,
    });
  }
}
