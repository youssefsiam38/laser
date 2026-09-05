/**
 * Help output. Generated from the command table, never hand-maintained, so a
 * command that exists is a command that is documented.
 */
import type { FlagSpec, FlagSpecs } from "./args.js";
import type { Command } from "./command.js";
import { GLOBAL_FLAGS } from "./flags.js";
import type { Painter, Terminal } from "./output.js";
import { CLI_VERSION } from "./version.js";

function flagLabel(name: string, spec: FlagSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "    ";
  const value =
    spec.type === "boolean" ? "" : ` ${spec.placeholder ?? (spec.choices ? `<${spec.choices.join("|")}>` : "<value>")}`;
  return `${short}--${name}${value}`;
}

function describeDefault(spec: FlagSpec): string {
  if (spec.default === undefined || spec.default === false) return "";
  return ` (default ${String(spec.default)})`;
}

function flagLines(specs: FlagSpecs, paint: Painter): string[] {
  const entries = Object.entries(specs).filter(([, spec]) => !spec.hidden);
  if (entries.length === 0) return [];
  const labels = entries.map(([name, spec]) => flagLabel(name, spec));
  const pad = Math.max(...labels.map((label) => label.length));
  return entries.map(([, spec], i) => {
    const label = (labels[i] as string).padEnd(pad);
    return `  ${label}  ${paint.dim(spec.description + describeDefault(spec))}`;
  });
}

export function renderRootHelp(commands: readonly Command[], term: Terminal): void {
  const p = term.err;
  const visible = commands.filter((command) => !command.hidden);
  const groups = ["Host", "Sessions", "Projects", "Pi", "Diagnostics", "Shell"] as const;

  term.note(`${p.bold("piorbit")} ${p.dim(CLI_VERSION)} — start, inspect and drive piorbit from a terminal.`);
  term.note();
  term.note(p.bold("USAGE"));
  term.note(`  piorbit ${p.dim("[command] [options]")}`);
  term.note(`  piorbit ${p.dim("with no command starts the host and opens the app")}`);
  term.note();

  for (const group of groups) {
    const inGroup = visible.filter((command) => command.group === group);
    if (inGroup.length === 0) continue;
    term.note(p.bold(group.toUpperCase()));
    const pad = Math.max(...inGroup.map((command) => command.name.length));
    for (const command of inGroup) {
      const alias = command.aliases?.length ? p.dim(` (${command.aliases.join(", ")})`) : "";
      term.note(`  ${command.name.padEnd(pad)}  ${command.summary}${alias}`);
    }
    term.note();
  }

  term.note(p.bold("GLOBAL OPTIONS"));
  for (const line of flagLines(GLOBAL_FLAGS, p)) term.note(line);
  term.note();
  term.note(p.bold("LEARN MORE"));
  term.note(`  piorbit <command> --help   ${p.dim("options and examples for one command")}`);
  term.note(`  piorbit help <topic>       ${p.dim(`topics: ${TOPICS.map((topic) => topic.name).join(", ")}`)}`);
}

export function renderCommandHelp(command: Command, term: Terminal): void {
  const p = term.err;
  term.note(`${p.bold(`piorbit ${command.name}`)} — ${command.summary}`);
  term.note();
  term.note(p.bold("USAGE"));
  term.note(`  ${command.usage}`);
  if (command.aliases?.length) term.note(`  ${p.dim(`alias: ${command.aliases.map((a) => `piorbit ${a}`).join(", ")}`)}`);
  term.note();

  if (command.description) {
    for (const line of command.description.trim().split("\n")) term.note(`  ${line}`);
    term.note();
  }

  if (command.positionals?.length) {
    term.note(p.bold("ARGUMENTS"));
    const pad = Math.max(...command.positionals.map((positional) => positional.name.length));
    for (const positional of command.positionals) {
      const optional = positional.optional ? p.dim(" (optional)") : "";
      term.note(`  ${positional.name.padEnd(pad)}  ${positional.description}${optional}`);
    }
    term.note();
  }

  const own = flagLines(command.flags ?? {}, p);
  if (own.length > 0) {
    term.note(p.bold("OPTIONS"));
    for (const line of own) term.note(line);
    term.note();
  }

  term.note(p.bold("GLOBAL OPTIONS"));
  for (const line of flagLines(GLOBAL_FLAGS, p)) term.note(line);

  if (command.examples?.length) {
    term.note();
    term.note(p.bold("EXAMPLES"));
    for (const example of command.examples) {
      term.note(`  ${p.dim(`# ${example.note}`)}`);
      term.note(`  ${example.command}`);
      term.note();
    }
  }
}

export interface Topic {
  name: string;
  title: string;
  body: string;
}

/** `piorbit help <topic>` — the things that do not belong to one command. */
export const TOPICS: readonly Topic[] = [
  {
    name: "pi",
    title: "Reaching Pi through piorbit",
    body: `
piorbit pins its own copy of Pi inside @piorbit/worker. That pinned copy is the
one the app runs, and \`piorbit pi\` runs the same one, so what you see in a
terminal and what you see in the app are the same agent at the same version.

  piorbit pi                     start Pi's TUI in the current directory
  piorbit pi --help              Pi's own help, verbatim
  piorbit pi update --extensions Pi's own update verb, verbatim
  piorbit pi models              Pi's own model list

Everything after \`piorbit pi\` belongs to Pi, including --help and --version.
piorbit only consumes flags that appear *before* the first Pi argument:

  --global-pi              run the \`pi\` on your PATH instead of the pinned one
  --agent-dir <dir>        override the agent directory for this run
  --subagents-temp-root <dir>

Children inherit PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR and
PI_SUBAGENTS_TEMP_ROOT from piorbit's resolution, which is why a background
subagent run started this way shows up in the app.

Exit codes and signals pass straight through: \`piorbit pi\` exits with Pi's
code, and a Pi killed by a signal kills the wrapper with the same signal.
`,
  },
  {
    name: "host",
    title: "The host process",
    body: `
One host serves every project. It binds 127.0.0.1 only; remote access is the
relay's job, never an open port.

  piorbit up            start it (or attach if it is already up) and open the app
  piorbit status        where it is, what it is serving, how long it has been up
  piorbit down          stop it
  piorbit restart       down, then up, keeping the same options

While it runs, \`<state-dir>/host.json\` holds its pid, port and the directories
it was started with; \`<state-dir>/host.log\` holds its output. The state
directory is \`~/.piorbit\` unless \`--state-dir\` or \`PIORBIT_STATE_DIR\` says
otherwise. Both files are removed when the host exits cleanly.

"Is it running" is always decided by asking /healthz, not by trusting the file.
The record also carries an identity for the process itself, so a record that
outlived a reboot is recognised as stale instead of pointing \`piorbit down\` at
whatever program inherited the pid.
`,
  },
  {
    name: "sessions",
    title: "Driving sessions from the terminal",
    body: `
Session verbs talk to the running host over the same WebSocket JSON-RPC the app
uses. They need a host: start one with \`piorbit up\`.

A session is identified by its file path. Any unambiguous suffix of that path,
or the session id, also works:

  piorbit sessions                       every session, newest first
  piorbit sessions --project .           only this directory
  piorbit new                            a session in the current directory
  piorbit send "run the tests"           prompt the most recent session here
  piorbit tail <id> --follow             watch it work
  piorbit stop <id>                      abort the current turn

\`send\` waits for the agent to settle and streams the answer unless you pass
--no-wait. \`--steer\` and \`--follow-up\` choose what happens when the agent is
already working: steer interrupts with new instructions, follow-up queues.
`,
  },
  {
    name: "doctor",
    title: "What doctor checks",
    body: `
\`piorbit doctor\` answers one question: would piorbit work right now, and if
not, what is the smallest thing you could change.

It checks the Node version, that the pinned Pi resolves and boots, that the
agent and session directories are writable and have room, which providers have
credentials (names only — it never reads or prints a secret), that a default
model resolves, that the port is free or held by piorbit itself, and that the
pi-subagents temp roots are usable. Finally it spawns a throwaway worker in a
temporary directory and opens a session in it, which is the only check that
proves the whole chain works.

Every failing row prints a fix. The exit code is 1 if any row FAILs, 0 if the
worst is a WARN.
`,
  },
  {
    name: "env",
    title: "Environment variables",
    body: `
Read by piorbit:

  PIORBIT_AGENT_DIR              agent directory (same as --agent-dir)
  PIORBIT_SESSION_DIR            session directory (same as --session-dir)
  PIORBIT_SUBAGENTS_TEMP_ROOT    pi-subagents temp root
  PIORBIT_PORT                   host port (same as --port)
  PIORBIT_STATE_DIR              piorbit's own state directory (same as --state-dir)
  NO_COLOR / FORCE_COLOR         colour, per no-color.org
  PI_CODING_AGENT_DIR            used when PIORBIT_AGENT_DIR is unset
  PI_CODING_AGENT_SESSION_DIR    used when PIORBIT_SESSION_DIR is unset
  PI_SUBAGENTS_TEMP_ROOT         used when PIORBIT_SUBAGENTS_TEMP_ROOT is unset

Set by piorbit for every Pi it starts (directly or through a worker):

  PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR, PI_SUBAGENTS_TEMP_ROOT, PIORBIT=1
`,
  },
  {
    name: "json",
    title: "Scripting piorbit",
    body: `
Every command takes --json. The rules never change:

  - the result goes to stdout as one JSON value;
  - progress, warnings and errors go to stderr;
  - streaming commands emit NDJSON instead: one JSON object per line, in order.
    Those are \`tail\`, \`send\` while waiting, and \`logs --follow\`. Without
    --follow, \`logs\` prints one object like everything else.

Exit codes:

  0  success
  1  the thing you asked for did not work (doctor found a FAIL)
  2  the command line was wrong
  3  no host is running
  4  the host answered with an error

\`piorbit pi\` is the exception: it exits with Pi's own code.
`,
  },
];

export function findTopic(name: string): Topic | undefined {
  return TOPICS.find((topic) => topic.name === name);
}
