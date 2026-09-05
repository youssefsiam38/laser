/**
 * Session verbs. Every one of them talks to the running host over the same
 * WebSocket JSON-RPC the app uses — there is no second code path into a
 * session, which is what keeps "what the CLI did" and "what the app shows" the
 * same thing.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { resolve } from "node:path";
import type { SessionState, SessionSummary, SessionUpdateParams } from "@piorbit/protocol";
import { bool, num, str } from "../args.js";
import type { Command, CommandContext } from "../command.js";
import { hostUrl } from "../config.js";
import { CliError, ExitCode } from "../errors.js";
import { openBrowser } from "../host-control.js";
import { ago, clip, sessionLabel, shortCwd, shortId } from "../format.js";
import { table, type Terminal } from "../output.js";
import { recentSession, rememberSession } from "../recent.js";
import { TailRenderer, firstLine } from "../render.js";
import { describeRpcError, type HostRpc } from "../rpc.js";
import { listSessions, resolveSession } from "../session-ref.js";
import { connect } from "./host.js";

const SESSION_FLAG = {
  session: { type: "string", short: "s", description: "Session id or path (default: the newest in the project)", placeholder: "<id>" },
} as const;

const PROJECT_FLAG = {
  project: { type: "string", short: "P", description: "Project directory (default: the current one)", placeholder: "<dir>" },
} as const;

function projectOf(context: CommandContext): string | undefined {
  const value = str(context.args, "project");
  return value === undefined ? undefined : resolve(value);
}

/**
 * The session a verb acts on. With no `--session` we take the newest session in
 * the project, which is almost always the one the person just used.
 *
 * The catalog is a scan of session *files*, and Pi writes a session file lazily,
 * so a session created seconds ago may not be in it yet. That is what the
 * `recent` note covers: it is consulted only when the catalog comes up empty,
 * and only after the host confirms the session by loading it.
 */
async function pick(rpc: HostRpc, context: CommandContext, reference?: string): Promise<SessionSummary> {
  const explicit = reference ?? str(context.args, "session");
  const project = projectOf(context);
  const cwd = project ?? (explicit === undefined ? process.cwd() : undefined);
  try {
    return await resolveSession(rpc, explicit, {
      ...(cwd !== undefined ? { cwd } : {}),
      allowLatest: explicit === undefined,
    });
  } catch (error) {
    const fallback = explicit === undefined && cwd !== undefined ? recentSession(context.paths.stateDir, cwd) : undefined;
    if (!fallback) throw error;
    const state = await loadSession(rpc, fallback).catch(() => undefined);
    if (!state) throw error;
    return {
      path: state.path,
      id: state.id,
      cwd: state.cwd,
      ...(state.name ? { name: state.name } : {}),
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      messageCount: state.messageCount,
    };
  }
}

async function loadSession(rpc: HostRpc, path: string): Promise<SessionState> {
  try {
    const { state } = await rpc.request("session/load", { path });
    return state;
  } catch (error) {
    throw describeRpcError(error, `could not open session ${path}`);
  }
}

// ------------------------------------------------------------------ sessions

export const sessionsCommand: Command = {
  name: "sessions",
  aliases: ["ls"],
  group: "Sessions",
  summary: "list sessions, newest first",
  usage: `${PRODUCT_NAME} sessions [--project <dir>] [--limit <n>] [--all]`,
  description: `
Lists the sessions the host knows about, across every project unless --project
narrows it. The ID column is short but usable: any unambiguous prefix works
wherever a command takes a session.
`,
  flags: {
    ...PROJECT_FLAG,
    limit: { type: "number", short: "n", description: "How many to show", placeholder: "<n>", default: 20 },
    all: { type: "boolean", short: "a", description: "Show every session, ignoring --limit" },
  },
  examples: [
    { note: "everything, newest first", command: `${PRODUCT_NAME} sessions` },
    { note: "just this directory", command: `${PRODUCT_NAME} sessions --project .` },
    { note: "the newest session's path, for scripting", command: `${PRODUCT_NAME} sessions -n 1 --json | jq -r '.sessions[0].path'` },
  ],
  async run(context) {
    const { term } = context;
    const rpc = await connect(context.paths);
    try {
      const project = projectOf(context);
      const all = await listSessions(rpc, project);
      const limit = bool(context.args, "all") ? all.length : (num(context.args, "limit") ?? 20);
      const shown = all.slice(0, Math.max(0, limit));

      if (term.json) {
        term.data({ sessions: shown, total: all.length });
        return;
      }
      if (all.length === 0) {
        term.note(project ? `no sessions in ${project}` : "no sessions yet");
        term.note();
        term.note(`  Start one with ${term.err.bold(`${PRODUCT_NAME} new`)}.`);
        return;
      }
      for (const line of table(
        shown,
        [
          { header: "id", get: (session) => term.out.bold(shortId(session.id)) },
          { header: "project", get: (session) => shortCwd(session.cwd) },
          { header: "modified", get: (session) => ago(session.modifiedAt) },
          {
            header: "name",
            get: (session) => clip(session.name ?? session.firstMessage ?? sessionLabel(session.path), 60),
          },
        ],
        term.out,
      )) {
        term.print(line);
      }
      if (shown.length < all.length) {
        term.note(term.err.dim(`  … ${all.length - shown.length} more; pass --all or --limit`));
      }
    } finally {
      rpc.close();
    }
  },
};

// ----------------------------------------------------------------------- new

export const newCommand: Command = {
  name: "new",
  group: "Sessions",
  summary: "start a session in a project directory",
  usage: `${PRODUCT_NAME} new [cwd]`,
  description: `
Starts a session in a directory, through the host's worker for that
directory. The session appears in the app immediately.
`,
  positionals: [{ name: "cwd", description: "Project directory", optional: true }],
  flags: {
    open: { type: "boolean", description: "Open the app at the new session" },
  },
  examples: [
    { note: "a session here", command: `${PRODUCT_NAME} new` },
    { note: "a session elsewhere, then prompt it", command: `${PRODUCT_NAME} new ~/code/api && ${PRODUCT_NAME} send -P ~/code/api "run the tests"` },
  ],
  async run(context) {
    const { term } = context;
    const cwd = resolve(context.args.positionals[0] ?? process.cwd());
    const rpc = await connect(context.paths);
    try {
      const { state } = await rpc.request("session/new", { cwd }).catch((error: unknown) => {
        throw describeRpcError(error, `could not start a session in ${cwd}`);
      });
      // Pi has not written the file yet, so nothing else could find this
      // session by scanning. Note it for the next command in this directory.
      rememberSession(context.paths.stateDir, cwd, state.path);
      const url = `${hostUrl(context.paths)}${sessionFragment(state.path)}`;
      if (bool(context.args, "open")) openBrowser(url);

      if (term.json) {
        term.data({ session: state, url });
        return;
      }
      term.note(`${term.err.green("started")} a session in ${shortCwd(cwd)}`);
      term.print(state.path);
      term.note(`  ${term.err.dim("id")}    ${state.id}`);
      term.note(`  ${term.err.dim("model")} ${state.model ? `${state.model.provider}/${state.model.id}` : "none resolved"}`);
      term.note(`  ${term.err.dim("app")}   ${url}`);
    } finally {
      rpc.close();
    }
  },
};

/** Deep link the app understands (see packages/cli/README.md § open). */
export function sessionFragment(path: string): string {
  return `/#/session/${encodeURIComponent(path)}`;
}

// ---------------------------------------------------------------------- open

export const openCommand: Command = {
  name: "open",
  group: "Sessions",
  summary: "attach a session in the host and open it in the app",
  usage: `${PRODUCT_NAME} open [session]`,
  description: `
Loads the session in its worker (so it is live, not just a file on disk) and
opens the app at it. With no argument it opens the newest session in the current
directory.
`,
  positionals: [{ name: "session", description: "Session id or path", optional: true }],
  flags: { ...SESSION_FLAG, ...PROJECT_FLAG, open: { type: "boolean", default: true, description: "Open a browser" } },
  examples: [
    { note: "open the newest session here", command: `${PRODUCT_NAME} open` },
    { note: "open one by id", command: `${PRODUCT_NAME} open 0f3a91c2` },
  ],
  async run(context) {
    const { term } = context;
    const rpc = await connect(context.paths);
    try {
      const summary = await pick(rpc, context, context.args.positionals[0]);
      const state = await loadSession(rpc, summary.path);
      const url = `${hostUrl(context.paths)}${sessionFragment(state.path)}`;
      const opened = bool(context.args, "open") ? openBrowser(url) : false;

      if (term.json) {
        term.data({ session: state, url, browserOpened: opened });
        return;
      }
      term.note(`${term.err.green("attached")} ${shortId(state.id)} in ${shortCwd(state.cwd)}`);
      term.print(url);
      if (bool(context.args, "open") && !opened) term.warn(`could not open a browser. Open ${url} yourself.`);
    } finally {
      rpc.close();
    }
  },
};

// ---------------------------------------------------------------------- send

export const sendCommand: Command = {
  name: "send",
  group: "Sessions",
  summary: "send a prompt to a session and stream the answer",
  usage: `${PRODUCT_NAME} send <text...> [--session <id>] [--steer|--follow-up] [--no-wait]`,
  description: `
Sends a prompt and, by default, streams the answer until the agent settles.

--steer and --follow-up decide what happens when the agent is already working:
steer interrupts with new instructions, follow-up queues the message for after
the current turn. Without either, the host uses the session's own mode.

Pass \`-\` as the text to read the prompt from stdin.
`,
  positionals: [{ name: "text...", description: "The prompt. `-` reads it from stdin", variadic: true }],
  flags: {
    ...SESSION_FLAG,
    ...PROJECT_FLAG,
    steer: { type: "boolean", description: "Interrupt the current turn with this message" },
    "follow-up": { type: "boolean", description: "Queue this message for after the current turn" },
    wait: { type: "boolean", default: true, description: "Stream the answer until the agent settles" },
    thinking: { type: "boolean", description: "Include thinking output while streaming" },
    timeout: { type: "number", description: "Give up after this many seconds (0 = never)", placeholder: "<seconds>", default: 0 },
  },
  examples: [
    { note: "prompt the newest session here", command: `${PRODUCT_NAME} send "run the tests and fix what breaks"` },
    { note: "interrupt a running agent", command: `${PRODUCT_NAME} send --steer "stop, do the smaller version first"` },
    { note: "fire and forget", command: `${PRODUCT_NAME} send --no-wait "update the changelog"` },
  ],
  async run(context) {
    const { term, args } = context;
    if (bool(args, "steer") && bool(args, "follow-up")) {
      throw new CliError("--steer and --follow-up ask for opposite things", {
        exitCode: ExitCode.Usage,
        fix: "Pass one of them, or neither to use the session's own mode.",
      });
    }
    const text = await promptText(args.positionals);
    const streamingBehavior = bool(args, "steer") ? "steer" : bool(args, "follow-up") ? "followUp" : undefined;

    const stream = new SessionStream(context, undefined);
    await stream.open((rpc, session) =>
      rpc
        .request("session/prompt", {
          path: session.path,
          content: [{ type: "text", text }],
          ...(streamingBehavior ? { streamingBehavior } : {}),
        })
        .catch((error: unknown) => {
          throw describeRpcError(error, "the host refused the prompt");
        }),
    );

    if (!bool(args, "wait")) {
      const { session, result } = stream;
      if (term.json) term.data({ session: session?.path, accepted: result?.accepted, queued: result?.queued });
      else term.note(result?.queued ? `${term.err.dim("queued")} for after the current turn` : `${term.err.green("sent")}`);
      stream.close();
      return;
    }

    if (stream.result?.queued && !term.json) {
      term.note(
        term.err.dim("queued behind the current turn — this wait ends at the next settle, which may be that turn's"),
      );
    }
    return stream.follow({
      until: "settled",
      thinking: bool(args, "thinking"),
      timeoutMs: (num(args, "timeout") ?? 0) * 1000,
    });
  },
};

async function promptText(positionals: readonly string[]): Promise<string> {
  const joined = positionals.join(" ").trim();
  if (joined !== "" && joined !== "-") return joined;
  if (joined === "-" || positionals.length === 0) {
    if (process.stdin.isTTY) {
      throw new CliError("no prompt given", {
        exitCode: ExitCode.Usage,
        fix: `Write it inline (\`${PRODUCT_NAME} send "..."\`) or pipe it in (\`echo ... | ${PRODUCT_NAME} send -\`).`,
      });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text === "") {
      throw new CliError("the prompt read from stdin was empty", {
        exitCode: ExitCode.Usage,
        fix: "Pipe some text in, or pass the prompt as an argument.",
      });
    }
    return text;
  }
  return joined;
}

// ---------------------------------------------------------------------- tail

export const tailCommand: Command = {
  name: "tail",
  group: "Sessions",
  summary: "stream a session's output as it happens",
  usage: `${PRODUCT_NAME} tail [session] [--follow] [--thinking]`,
  description: `
Prints assistant text as it streams, tool calls with their durations, extension
dialogs, and errors. Exits when the agent settles; --follow keeps watching for
the next turn instead.

An idle session with no --follow exits immediately rather than waiting for a
settle that will never come.

With --json it emits NDJSON: one \`session/update\` params object per line.
`,
  positionals: [{ name: "session", description: "Session id or path", optional: true }],
  flags: {
    ...SESSION_FLAG,
    ...PROJECT_FLAG,
    follow: { type: "boolean", short: "f", description: "Keep watching after the agent settles" },
    thinking: { type: "boolean", description: "Include thinking output" },
    timeout: { type: "number", description: "Give up after this many seconds (0 = never)", placeholder: "<seconds>", default: 0 },
  },
  examples: [
    { note: "watch the newest session here", command: `${PRODUCT_NAME} tail` },
    { note: "keep watching, forever", command: `${PRODUCT_NAME} tail --follow` },
    { note: "machine-readable stream", command: `${PRODUCT_NAME} tail --json | jq -r 'select(.update.kind==\"text_delta\").update.delta'` },
  ],
  async run(context) {
    const stream = new SessionStream(context, context.args.positionals[0]);
    await stream.open();
    const follow = bool(context.args, "follow");
    if (!follow && stream.state && !stream.state.isStreaming && !stream.state.isCompacting) {
      const { term, args: _args } = context;
      if (term.json) term.data({ session: stream.state.path, idle: true, state: stream.state });
      else term.note(`${term.err.dim("idle")} — ${shortId(stream.state.id)} is not running. Pass --follow to wait for the next turn.`);
      stream.close();
      return;
    }
    return stream.follow({
      until: follow ? "forever" : "settled",
      thinking: bool(context.args, "thinking"),
      timeoutMs: (num(context.args, "timeout") ?? 0) * 1000,
    });
  },
};

// ---------------------------------------------------------------------- stop

export const stopCommand: Command = {
  name: "stop",
  group: "Sessions",
  summary: "abort a session's current turn",
  usage: `${PRODUCT_NAME} stop [session]`,
  description: `
Aborts what the agent is doing now. The session stays open and keeps everything
it has produced so far; this is Escape in the app, not a delete.
`,
  positionals: [{ name: "session", description: "Session id or path", optional: true }],
  flags: { ...SESSION_FLAG, ...PROJECT_FLAG },
  examples: [{ note: "stop the newest session here", command: `${PRODUCT_NAME} stop` }],
  async run(context) {
    const { term } = context;
    const rpc = await connect(context.paths);
    try {
      const summary = await pick(rpc, context, context.args.positionals[0]);
      const state = await loadSession(rpc, summary.path);
      if (!state.isStreaming && !state.isCompacting) {
        if (term.json) term.data({ session: state.path, aborted: false, reason: "not running" });
        else term.note(`${term.err.dim("nothing to stop")} — ${shortId(state.id)} is idle`);
        return;
      }
      await rpc.request("session/cancel", { path: state.path }).catch((error: unknown) => {
        throw describeRpcError(error, "could not stop the session");
      });
      if (term.json) term.data({ session: state.path, aborted: true });
      else term.note(`${term.err.green("stopped")} ${shortId(state.id)}`);
    } finally {
      rpc.close();
    }
  },
};

// ------------------------------------------------------------------- entries

export const entriesCommand: Command = {
  name: "entries",
  group: "Sessions",
  summary: "list a session's entries and their ids (what `fork` needs)",
  usage: `${PRODUCT_NAME} entries [session] [--limit <n>]`,
  description: `
Prints the persisted entries of a session with their ids, newest last, so you
can find the entry to fork from. Entry shapes come from the agent's own session
file, not from ${PRODUCT_NAME}; the preview column is best-effort.
`,
  positionals: [{ name: "session", description: "Session id or path", optional: true }],
  flags: {
    ...SESSION_FLAG,
    ...PROJECT_FLAG,
    limit: { type: "number", short: "n", description: "Show only the last n entries", placeholder: "<n>", default: 30 },
  },
  examples: [{ note: "find a fork point", command: `${PRODUCT_NAME} entries | tail -20` }],
  async run(context) {
    const { term } = context;
    const rpc = await connect(context.paths);
    try {
      const summary = await pick(rpc, context, context.args.positionals[0]);
      await loadSession(rpc, summary.path);
      const { entries } = await rpc.request("pi/session/entries", { path: summary.path }).catch((error: unknown) => {
        throw describeRpcError(error, "could not read the session's entries");
      });
      const limit = num(context.args, "limit") ?? 30;
      const shown = entries.slice(-Math.max(1, limit)).map(describeEntry);

      if (term.json) {
        term.data({ session: summary.path, entries: entries.slice(-Math.max(1, limit)) });
        return;
      }
      if (shown.length === 0) {
        term.note("this session has no entries yet");
        return;
      }
      for (const line of table(
        shown,
        [
          { header: "id", get: (entry) => term.out.bold(entry.id) },
          { header: "kind", get: (entry) => entry.kind },
          { header: "preview", get: (entry) => entry.preview },
        ],
        term.out,
      )) {
        term.print(line);
      }
    } finally {
      rpc.close();
    }
  },
};

/**
 * Entries are Pi's shape, deliberately opaque above the worker, so read them
 * defensively: pull an id, a kind and whatever text is findable, and never
 * assume a field exists.
 */
export function describeEntry(entry: unknown): { id: string; kind: string; preview: string } {
  const record = (entry ?? {}) as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"] : "—";
  const type = typeof record["type"] === "string" ? record["type"] : "entry";
  const message = (record["message"] ?? {}) as Record<string, unknown>;
  const role = typeof message["role"] === "string" ? message["role"] : undefined;
  const kind = role ? `${type}:${role}` : type;
  return { id, kind, preview: firstLine(textOf(record), 70) };
}

/** Best-effort text of an entry: message content parts, then any `text` field. */
function textOf(record: Record<string, unknown>): string {
  const message = record["message"];
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content.map((part) => {
        const item = (part ?? {}) as Record<string, unknown>;
        if (typeof item["text"] === "string") return item["text"];
        if (typeof item["name"] === "string") return `[${item["type"] ?? "part"} ${item["name"]}]`;
        return typeof item["type"] === "string" ? `[${item["type"]}]` : "";
      });
      const joined = parts.filter(Boolean).join(" ");
      if (joined) return joined;
    }
  }
  for (const key of ["text", "content", "label", "summary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

// ---------------------------------------------------------------------- fork

export const forkCommand: Command = {
  name: "fork",
  group: "Sessions",
  summary: "fork a session before one of its entries",
  usage: `${PRODUCT_NAME} fork <session> <entry>`,
  description: `
Creates a new session containing everything before \`entry\`. The text of that
entry comes back so you can edit and resend it — the CLI prints it, and
--json returns it as \`editorText\`.

\`${PRODUCT_NAME} entries\` lists the entry ids.
`,
  positionals: [
    { name: "session", description: "Session id or path" },
    { name: "entry", description: `Entry id to fork before (see \`${PRODUCT_NAME} entries\`)` },
  ],
  flags: { ...PROJECT_FLAG },
  examples: [{ note: "fork before an entry and see the text to edit", command: `${PRODUCT_NAME} fork 0f3a91c2 e_71f4` }],
  async run(context) {
    const { term } = context;
    const [reference, entryId] = context.args.positionals;
    if (!reference || !entryId) {
      throw new CliError("fork needs a session and an entry id", {
        exitCode: ExitCode.Usage,
        fix: `Run \`${PRODUCT_NAME} entries <session>\` to see the entry ids, then \`${PRODUCT_NAME} fork <session> <entry>\`.`,
      });
    }
    const rpc = await connect(context.paths);
    try {
      const summary = await pick(rpc, context, reference);
      await loadSession(rpc, summary.path);
      const result = await rpc.request("pi/session/fork", { path: summary.path, entryId }).catch((error: unknown) => {
        throw describeRpcError(error, `could not fork before entry ${entryId}`);
      });

      if (term.json) {
        term.data(result);
        return;
      }
      term.note(`${term.err.green("forked")} ${shortId(summary.id)} before ${entryId}`);
      term.print(result.state.path);
      if (result.editorText) {
        term.note();
        term.note(term.err.dim("  the forked entry's text, to edit and resend:"));
        for (const line of result.editorText.split("\n")) term.note(`    ${line}`);
      }
    } finally {
      rpc.close();
    }
  },
};

// -------------------------------------------------------------------- rename

export const renameCommand: Command = {
  name: "rename",
  group: "Sessions",
  summary: "give a session a name",
  usage: `${PRODUCT_NAME} rename [session] <name>`,
  description: `
Names a session so it is findable in the app's sidebar and in
\`${PRODUCT_NAME} sessions\`. With one argument, the newest session in this directory is
renamed.
`,
  positionals: [
    { name: "session", description: "Session id or path", optional: true },
    { name: "name", description: "The new name" },
  ],
  flags: { ...SESSION_FLAG, ...PROJECT_FLAG },
  examples: [
    { note: "name the newest session here", command: `${PRODUCT_NAME} rename "relay spike"` },
    { note: "name a specific one", command: `${PRODUCT_NAME} rename 0f3a91c2 "relay spike"` },
  ],
  async run(context) {
    const { term } = context;
    const positionals = context.args.positionals;
    const explicitSession = str(context.args, "session");
    const [first, second] = positionals;
    const reference = second !== undefined ? first : explicitSession;
    const name = second ?? first;
    if (!name) {
      throw new CliError("rename needs a name", {
        exitCode: ExitCode.Usage,
        fix: `Write it as \`${PRODUCT_NAME} rename "the new name"\`, or \`${PRODUCT_NAME} rename <session> "the new name"\`.`,
      });
    }
    const rpc = await connect(context.paths);
    try {
      const summary = await pick(rpc, context, reference);
      await loadSession(rpc, summary.path);
      await rpc.request("pi/session/rename", { path: summary.path, name }).catch((error: unknown) => {
        throw describeRpcError(error, "could not rename the session");
      });
      if (term.json) term.data({ session: summary.path, name });
      else term.note(`${term.err.green("renamed")} ${shortId(summary.id)} to ${JSON.stringify(name)}`);
    } finally {
      rpc.close();
    }
  },
};

// ------------------------------------------------------------------- compact

export const compactCommand: Command = {
  name: "compact",
  group: "Sessions",
  summary: "compact a session's context",
  usage: `${PRODUCT_NAME} compact [session] [--instructions <text>]`,
  description: `
Asks the session to summarise its history so the context window has room again.
Waits for the compaction to finish and reports whether it worked; --no-wait
returns as soon as the host accepts the request.

Compaction guidance goes in --instructions, not in a positional, so a session
reference and a sentence can never be confused for one another.
`,
  positionals: [{ name: "session", description: "Session id or path", optional: true }],
  flags: {
    ...SESSION_FLAG,
    ...PROJECT_FLAG,
    wait: { type: "boolean", default: true, description: "Wait for the compaction to finish" },
    instructions: { type: "string", description: "Compaction instructions", placeholder: "<text>" },
  },
  examples: [
    { note: "compact the newest session here", command: `${PRODUCT_NAME} compact` },
    { note: "compact with guidance", command: `${PRODUCT_NAME} compact --instructions "keep the failing test output"` },
  ],
  async run(context) {
    const { term, args } = context;
    const instructions = str(args, "instructions");
    const stream = new SessionStream(context, args.positionals[0]);
    await stream.open((rpc, session) =>
      rpc
        .request("pi/session/compact", { path: session.path, ...(instructions ? { instructions } : {}) })
        .catch((error: unknown) => {
          throw describeRpcError(error, "could not compact the session");
        }),
    );
    if (!bool(args, "wait")) {
      if (term.json) term.data({ session: stream.session?.path, requested: true });
      else term.note(`${term.err.dim("compaction requested")}`);
      stream.close();
      return;
    }
    return stream.follow({ until: "compacted", thinking: false, timeoutMs: 0 });
  },
};

// -------------------------------------------------------------- the streamer

interface FollowOptions {
  until: "settled" | "compacted" | "forever";
  thinking: boolean;
  /** 0 means no timeout. */
  timeoutMs: number;
}

/**
 * Shared plumbing for the three commands that watch a session: connect, attach
 * to one session, run an action, then render updates until a stopping
 * condition. Kept in one class because the ordering is the subtle part —
 * the notification handler must be installed before the action runs, or a fast
 * first token is lost.
 */
class SessionStream {
  private rpc: HostRpc | undefined;
  session: SessionSummary | undefined;
  state: SessionState | undefined;
  result: { accepted: boolean; queued: boolean } | undefined;
  private readonly buffered: SessionUpdateParams[] = [];
  private renderer: TailRenderer | undefined;
  private done: ((value: void) => void) | undefined;
  private failure: CliError | undefined;
  private settled = false;

  constructor(
    private readonly context: CommandContext,
    /** The session reference this command's positionals carry, if any. */
    private readonly reference: string | undefined,
  ) {}

  private get term(): Terminal {
    return this.context.term;
  }

  /** Connect, resolve the session, attach, then run `action` (if any). */
  async open(action?: (rpc: HostRpc, session: SessionSummary) => Promise<unknown>): Promise<void> {
    const rpc = await connect(this.context.paths, (method, params) => this.onNotification(method, params));
    this.rpc = rpc;
    try {
      const summary = await pick(rpc, this.context, this.reference);
      this.session = summary;
      this.state = await loadSession(rpc, summary.path);
      if (action) this.result = (await action(rpc, summary)) as { accepted: boolean; queued: boolean } | undefined;
    } catch (error) {
      // Leaving the socket open would keep the process alive after the error.
      this.close();
      throw error;
    }
  }

  close(): void {
    this.rpc?.close();
    this.rpc = undefined;
  }

  /** Render until the stopping condition, then resolve. */
  async follow(options: FollowOptions): Promise<number | void> {
    const term = this.term;
    const session = this.session;
    if (!session) throw new CliError("internal: follow() before open()");

    this.renderer = new TailRenderer({
      paint: term.out,
      write: (text) => term.write(text),
      thinking: options.thinking,
    });
    if (!term.json) {
      term.note(
        `${term.err.dim("tailing")} ${shortId(session.id)} ${term.err.dim("in")} ${shortCwd(session.cwd)} ${term.err.dim("— Ctrl-C to stop")}`,
      );
    }

    // Arm the stopping condition before draining, so a buffered `agent_settled`
    // ends the wait instead of being queued a second time.
    this.stopWhen = options;
    const waiter = new Promise<void>((resolve) => (this.done = resolve));
    for (const params of this.buffered.splice(0)) this.render(params, options);

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        this.failure = new CliError(`gave up after ${Math.round(options.timeoutMs / 1000)}s`, {
          fix: `Raise --timeout, or pass --no-wait and watch with \`${PRODUCT_NAME} tail --follow\`.`,
        });
        this.finish();
      }, options.timeoutMs);
      timer.unref?.();
    }

    const onInterrupt = () => this.finish();
    process.once("SIGINT", onInterrupt);

    try {
      await waiter;
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", onInterrupt);
      this.renderer?.finish();
      this.close();
    }
    if (this.failure) throw this.failure;
    return undefined;
  }

  private stopWhen: FollowOptions | undefined;

  private onNotification(method: string, params: unknown): void {
    const options = this.stopWhen;
    if (!this.session) return;
    if (method === "session/update") {
      const update = params as SessionUpdateParams;
      if (update.sessionPath !== this.session.path) return;
      if (!options) {
        this.buffered.push(update);
        return;
      }
      this.render(update, options);
      return;
    }
    if (!options || this.term.json) return;
    if (method === "pi/ui/request") {
      const request = params as { path: string } & Parameters<TailRenderer["dialog"]>[0];
      if (request.path === this.session.path) this.renderer?.dialog(request);
      return;
    }
    if (method === "pi/ui/event") {
      const event = params as { path: string } & Parameters<TailRenderer["event"]>[0];
      if (event.path === this.session.path) this.renderer?.event(event);
    }
  }

  private render(params: SessionUpdateParams, options: FollowOptions): void {
    if (this.term.json) {
      this.term.record(params);
    } else {
      const settledNow = this.renderer?.update(params.update) ?? false;
      if (settledNow && options.until === "settled") return this.finish();
    }
    if (this.term.json && params.update.kind === "agent_settled" && options.until === "settled") return this.finish();
    if (params.update.kind === "compaction_end" && options.until === "compacted") {
      if (!params.update.ok) {
        this.failure = new CliError("the compaction failed", {
          fix: "Check the session in the app; a compaction needs a working model and enough context budget.",
        });
      }
      return this.finish();
    }
    if (params.update.kind === "agent_settled" && options.until === "compacted") {
      // The agent stopped without ever reporting a compaction: do not hang.
      this.failure = new CliError("the session settled without compacting", {
        fix: "Check the session in the app; compaction may have been refused.",
      });
      this.finish();
    }
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.done?.();
  }
}

export const sessionCommands: readonly Command[] = [
  sessionsCommand,
  newCommand,
  openCommand,
  sendCommand,
  tailCommand,
  stopCommand,
  entriesCommand,
  forkCommand,
  renameCommand,
  compactCommand,
];
