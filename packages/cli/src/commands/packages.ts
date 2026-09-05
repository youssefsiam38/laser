/**
 * `piorbit packages` — Pi's package manager, from a terminal (M9-T5).
 *
 * Everything goes through `pi/packages/*` on the host, which reaches the
 * project's worker and Pi's own `DefaultPackageManager`. Install and update do
 * real network and filesystem work and can take a while, so progress arrives as
 * `pi/packages/progress` notifications and is printed as it happens rather than
 * leaving a person staring at a still cursor.
 */
import { resolve } from "node:path";
import type { PackageEntry, PackageProgress, PackageScope } from "@piorbit/protocol";
import { bool, str } from "../args.js";
import type { Command, CommandContext } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { plural, shortCwd } from "../format.js";
import { sanitize, table, type Terminal } from "../output.js";
import { describeRpcError } from "../rpc.js";
import { connect } from "./host.js";

const VERBS = ["list", "install", "remove", "update", "check"] as const;
type Verb = (typeof VERBS)[number];

function verbOf(positionals: readonly string[]): { verb: Verb; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first === undefined) return { verb: "list", rest: [] };
  if ((VERBS as readonly string[]).includes(first)) return { verb: first as Verb, rest };
  throw new CliError(`unknown packages verb ${JSON.stringify(first)}`, {
    exitCode: ExitCode.Usage,
    fix: `Use one of: ${VERBS.join(", ")}. \`piorbit packages\` on its own lists them.`,
  });
}

function scopeOf(args: CommandContext["args"]): PackageScope {
  const value = str(args, "scope") ?? "user";
  // `piorbit settings` calls the same file "global"; both spellings work here.
  if (value === "global") return "user";
  if (value !== "user" && value !== "project") {
    throw new CliError(`unknown package scope ${JSON.stringify(value)}`, {
      exitCode: ExitCode.Usage,
      fix: "Use --scope user (the default, every project; `global` is accepted too) or --scope project (this one only).",
    });
  }
  return value;
}

function printPackages(term: Terminal, packages: readonly PackageEntry[]): void {
  if (packages.length === 0) {
    term.note("no packages installed");
    term.note();
    term.note(`  Install one with ${term.err.bold("piorbit packages install pi-web-access")}`);
    return;
  }
  for (const line of table(
    [...packages],
    [
      { header: "package", get: (entry) => sanitize(entry.source) },
      { header: "scope", get: (entry) => entry.scope },
      { header: "type", get: (entry) => entry.type ?? "—" },
      { header: "resources", get: (entry) => (entry.filtered ? "filtered" : "all") },
      { header: "update", get: (entry) => (entry.updateAvailable ? "available" : "") },
    ],
    term.out,
  )) {
    term.print(line);
  }
}

export const packagesCommand: Command = {
  name: "packages",
  group: "Projects",
  summary: "install, remove and update Pi packages",
  usage: "piorbit packages [list|install <source>|remove <source>|update [source]|check] [--scope <user|project>]",
  description: `
Drives Pi's own package manager through the worker for a project, so the result
is identical to running \`pi\`'s package commands — same install directory, same
settings entry — and the app sees it immediately.

A source is an npm package name or a git URL, exactly as Pi accepts it.
--scope user (the default) makes it available in every project; --scope project
adds it to this project's own settings.
`,
  positionals: [
    { name: "verb", description: "list (default), install, remove, update, check", optional: true },
    { name: "source", description: "npm package name or git URL", optional: true },
  ],
  flags: {
    project: { type: "string", short: "P", description: "Project directory (default: the current one)", placeholder: "<dir>" },
    scope: {
      type: "string",
      description: "Which settings file records the package (`global` is accepted as a synonym for `user`)",
      placeholder: "<user|project>",
      choices: ["user", "global", "project"],
      default: "user",
    },
    progress: { type: "boolean", default: true, description: "Print progress while installing" },
  },
  examples: [
    { note: "what is installed", command: "piorbit packages" },
    { note: "add a package for every project", command: "piorbit packages install pi-web-access" },
    { note: "check npm and git for newer versions", command: "piorbit packages check" },
  ],
  async run({ term, paths, args }) {
    const { verb, rest } = verbOf(args.positionals);
    const cwd = resolve(str(args, "project") ?? process.cwd());
    const showProgress = bool(args, "progress") && !term.json;

    const rpc = await connect(paths, (method, params) => {
      if (method !== "pi/packages/progress" || !showProgress) return;
      const progress = params as PackageProgress;
      if (progress.cwd !== cwd) return;
      const text = progress.message ?? `${progress.action} ${progress.source}`;
      const line = `  ${sanitize(text)}`;
      term.note(progress.type === "error" ? term.err.red(line) : term.err.dim(line));
    });

    try {
      if (verb === "list") {
        const { packages } = await rpc.request("pi/packages/list", { cwd }).catch((error: unknown) => {
          throw describeRpcError(error, `could not list packages for ${cwd}`);
        });
        if (term.json) term.data({ cwd, packages });
        else {
          term.note(term.err.bold(shortCwd(cwd)));
          printPackages(term, packages);
        }
        return;
      }

      if (verb === "check") {
        const { updates } = await rpc.request("pi/packages/check_updates", { cwd }).catch((error: unknown) => {
          throw describeRpcError(error, "could not check for updates");
        });
        if (term.json) {
          term.data({ cwd, updates });
          return;
        }
        if (updates.length === 0) {
          term.note(`${term.err.green("up to date")} — no package has a newer version`);
          return;
        }
        for (const line of table(
          [...updates],
          [
            { header: "package", get: (update) => sanitize(update.displayName) },
            { header: "source", get: (update) => sanitize(update.source) },
            { header: "scope", get: (update) => update.scope },
            { header: "type", get: (update) => update.type },
          ],
          term.out,
        )) {
          term.print(line);
        }
        term.note();
        term.note(`  Update them all with ${term.err.bold("piorbit packages update")}`);
        return;
      }

      if (verb === "update") {
        const source = rest[0];
        if (showProgress) term.note(source ? `updating ${source}…` : "updating every configured package…");
        const { packages } = await rpc
          .request("pi/packages/update", { cwd, ...(source ? { source } : {}) })
          .catch((error: unknown) => {
            throw describeRpcError(error, source ? `could not update ${source}` : "could not update packages");
          });
        if (term.json) term.data({ cwd, updated: source ?? null, packages });
        else {
          term.note(`${term.err.green("updated")} ${source ? sanitize(source) : plural(packages.length, "package")}`);
          printPackages(term, packages);
        }
        return;
      }

      const source = rest[0];
      if (!source) {
        throw new CliError(`\`packages ${verb}\` needs a package source`, {
          exitCode: ExitCode.Usage,
          fix: `Write it as \`piorbit packages ${verb} <npm-name-or-git-url>\`. \`piorbit packages\` lists what is installed.`,
        });
      }
      const scope = scopeOf(args);

      if (verb === "install") {
        if (showProgress) term.note(`installing ${sanitize(source)} (${scope})…`);
        const { packages } = await rpc
          .request("pi/packages/install", { cwd, source, scope })
          .catch((error: unknown) => {
            throw describeRpcError(error, `could not install ${source}`);
          });
        if (term.json) term.data({ cwd, installed: source, scope, packages });
        else {
          term.note(`${term.err.green("installed")} ${sanitize(source)} ${term.err.dim(`(${scope})`)}`);
          term.note(term.err.dim("Open sessions load it on their next start."));
        }
        return;
      }

      const { packages, removed } = await rpc
        .request("pi/packages/remove", { cwd, source, scope })
        .catch((error: unknown) => {
          throw describeRpcError(error, `could not remove ${source}`);
        });
      if (term.json) {
        term.data({ cwd, source, scope, removed, packages });
        return;
      }
      if (!removed) {
        term.warn(`${sanitize(source)} was not in the ${scope} package list; nothing changed`);
        printPackages(term, packages);
        return;
      }
      term.note(`${term.err.green("removed")} ${sanitize(source)} ${term.err.dim(`(${scope})`)}`);
    } finally {
      rpc.close();
    }
  },
};
