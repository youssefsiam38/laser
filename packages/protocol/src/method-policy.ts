/**
 * The per-method authorization table (RP-13).
 *
 * One row per client method, and the compiler refuses a method without one:
 * `METHOD_POLICY satisfies Record<ClientMethod, MethodPolicy>` is the same
 * fail-closed device `clientParamsSchemas` uses for params. A method the table
 * does not know is not "allowed by default" anywhere — {@link methodPolicy}
 * answers `undefined` and the host refuses before it parses anything.
 *
 * Two orthogonal dimensions, deliberately separate:
 *
 * - **scope** — what kind of authority the call is. Scopes are what an
 *   environment policy or a device grant may take away, and what the
 *   environment descriptor publishes.
 * - **reach** — which proven connection classes may call it at all. Reach is
 *   never narrowed or widened by anyone: it is a property of the method.
 *
 * Nothing here reads a request body. The caller's class is proved by the host
 * at its socket/relay boundary; a client cannot assert it.
 */
import type { ClientMethod } from "./messages.js";
import type { HostNotifications } from "./messages.js";

/**
 * What kind of authority a method exercises.
 *
 * - `handshake` — version and environment description. Always available to a
 *   connection that got as far as being authenticated; narrowing it would
 *   leave a client unable to learn what it may do.
 * - `read` — reading conversations, projects, settings, catalogs and fleet
 *   state, including the acknowledgement that a person has seen a session.
 * - `session_write` — anything that changes a conversation or drives a turn.
 * - `approval` — answering a question or a tool approval. Separate from
 *   `session_write` because it is the single largest authority in the product
 *   and an environment may want to read remotely without granting it.
 * - `work_control` — stopping or restarting work and runtimes: workers,
 *   background commands, agent runs, a child's worktree.
 * - `execution` — running something this machine can execute: an MCP server's
 *   tool, or the command a project's environment helper runs. Separate from
 *   `settings` on purpose, so an environment can let a connection configure
 *   the product without letting it run an executable through it.
 * - `settings` — configuration that outlives a turn: projects and trust,
 *   provider sign-in, MCP servers, keybindings, preferences, agent
 *   definitions, the shell's private environment overlay.
 * - `features` — Laser's own feature enablement and the search connection.
 * - `diagnostics` — logs and resource inventory.
 * - `device` — the calling device's own push registration, so a read-only
 *   remote device can still be reachable.
 */
export type MethodScope =
  | "handshake"
  | "read"
  | "session_write"
  | "approval"
  | "work_control"
  | "execution"
  | "settings"
  | "features"
  | "diagnostics"
  | "device";

export const METHOD_SCOPES: readonly MethodScope[] = [
  "handshake",
  "read",
  "session_write",
  "approval",
  "work_control",
  "execution",
  "settings",
  "features",
  "diagnostics",
  "device",
] as const;

export function isMethodScope(value: unknown): value is MethodScope {
  return typeof value === "string" && (METHOD_SCOPES as readonly string[]).includes(value);
}

/**
 * Which proven connection classes may call a method.
 *
 * - `any` — every authenticated connection, including a paired device.
 * - `native` — a local process with no browser origin: the app shell or the
 *   command line. A page — even one served by this host — is not one.
 *
 * There is deliberately no third value. A "this machine, browser or not" reach
 * would have no row today, and an unused authority level is one more thing to
 * get wrong than it is a thing that protects anybody. Add it when a method
 * needs it, with the row that needs it.
 */
export type MethodReach = "any" | "native";

/** How the host proved who is calling. Never taken from a request body. */
export type ActorClass = "local_app" | "local_browser" | "paired_device";

export interface MethodPolicy {
  scope: MethodScope;
  reach: MethodReach;
  /** The sentence a person sees when *reach* refuses the call. */
  refusal?: string;
  /**
   * How the access audit records a *successful* call of this method.
   *
   * `"summary"` marks a high-frequency stream — a method a person's normal use
   * calls tens or hundreds of times a minute. Those are counted per actor and
   * written as one row per window instead of one row per call, so ordinary use
   * cannot spend the per-call allowance or the capacity reserved for
   * refusals. Refusals and errors are always individual rows, whatever this
   * says: the reason for a refusal is the record that matters.
   */
  audit?: "summary";
}

const NATIVE_ENVIRONMENT_REFUSAL = "Environment updates are only accepted from a local app or terminal.";
const NATIVE_REPORT_REFUSAL = "Process metrics are only accepted from the app running on this machine.";
const NATIVE_SYNC_REFUSAL = "The app sends this to its own workers.";

/** Reach for one actor class. */
export function reachAllows(reach: MethodReach, actor: ActorClass): boolean {
  switch (reach) {
    case "any":
      return true;
    case "native":
      return actor === "local_app";
  }
}

/**
 * Every client method, with the authority it exercises and where it may be
 * called from.
 *
 * Reach is `any` unless the method describes or reconfigures *this machine*
 * rather than the product's own state. Only three methods are not `any`, and
 * all three were already refused for remote callers before this table existed.
 */
export const METHOD_POLICY = {
  // ---------------------------------------------------------- handshake ---
  "pi/host/version": { scope: "handshake", reach: "any" },
  "environment/describe": { scope: "handshake", reach: "any" },

  // --------------------------------------------------------------- read ---
  "session/load": { scope: "read", reach: "any" },
  "session/revision": { scope: "read", reach: "any" },
  "session/search": { scope: "read", reach: "any" },
  "session/search/cancel": { scope: "read", reach: "any" },
  "session/goal/get": { scope: "read", reach: "any" },
  "session/pending/list": { scope: "read", reach: "any" },
  "pi/session/list": { scope: "read", reach: "any" },
  "pi/session/inbox": { scope: "read", reach: "any" },
  "pi/session/entries": { scope: "read", reach: "any" },
  // Reading a session is what marks it seen; a viewer that cannot acknowledge
  // would leave every conversation permanently unread.
  "pi/session/seen": { scope: "read", reach: "any" },
  "pi/session/detach": { scope: "read", reach: "any" },
  "pi/model/list": { scope: "read", reach: "any" },
  "pi/account-usage/refresh": { scope: "read", reach: "any" },
  "pi/project/list": { scope: "read", reach: "any" },
  "pi/project/git": { scope: "read", reach: "any" },
  "pi/project/browse": { scope: "read", reach: "any" },
  "pi/project/files": { scope: "read", reach: "any" },
  // Machine-wide file preview, deliberately available to a paired device:
  // pairing already grants prompts and command approval (docs/security.md).
  "pi/project/read": { scope: "read", reach: "any" },
  "pi/project/env/status": { scope: "read", reach: "any" },
  "pi/settings/list": { scope: "read", reach: "any" },
  "pi/settings/get": { scope: "read", reach: "any" },
  "pi/keybindings/get": { scope: "read", reach: "any" },
  "pi/providers/list": { scope: "read", reach: "any" },
  "pi/models/catalog": { scope: "read", reach: "any" },
  "pi/commands/list": { scope: "read", reach: "any" },
  "pi/prompts/list": { scope: "read", reach: "any" },
  "pi/prefs/get": { scope: "read", reach: "any" },
  "pi/worker/list": { scope: "read", reach: "any" },
  "pi/setup/state": { scope: "read", reach: "any" },
  "pi/transcribe/status": { scope: "read", reach: "any" },
  "mcp/list": { scope: "read", reach: "any" },
  "mcp/import/detect": { scope: "read", reach: "any" },
  "tasks/list": { scope: "read", reach: "any" },
  "tasks/output": { scope: "read", reach: "any" },
  "agents/list": { scope: "read", reach: "any" },
  "agents/skills": { scope: "read", reach: "any" },
  "agents/engine-instructions": { scope: "read", reach: "any" },
  "agents/runs/list": { scope: "read", reach: "any" },
  "agents/worktree/status": { scope: "read", reach: "any" },
  // Retired wire methods. They only ever answer with the breaking-change
  // sentence, so they cost no authority; they still need a row.
  "pi/packages/list": { scope: "read", reach: "any" },
  "pi/packages/install": { scope: "read", reach: "any" },
  "pi/packages/remove": { scope: "read", reach: "any" },
  "pi/packages/update": { scope: "read", reach: "any" },
  "pi/packages/check_updates": { scope: "read", reach: "any" },
  "pi/packages/catalog": { scope: "read", reach: "any" },
  "pi/packages/runtime": { scope: "read", reach: "any" },
  "pi/packages/records": { scope: "read", reach: "any" },

  // ------------------------------------------------------ session writes ---
  "session/new": { scope: "session_write", reach: "any" },
  "session/prompt": { scope: "session_write", reach: "any" },
  "session/cancel": { scope: "session_write", reach: "any" },
  "session/set_mode": { scope: "session_write", reach: "any" },
  "session/goal/action": { scope: "session_write", reach: "any" },
  "session/pending/add": { scope: "session_write", reach: "any" },
  "session/pending/edit": { scope: "session_write", reach: "any" },
  "session/pending/remove": { scope: "session_write", reach: "any" },
  "session/pending/steer": { scope: "session_write", reach: "any" },
  "session/pending/clear": { scope: "session_write", reach: "any" },
  "pi/session/steer": { scope: "session_write", reach: "any" },
  "pi/session/follow_up": { scope: "session_write", reach: "any" },
  "pi/session/clear_queue": { scope: "session_write", reach: "any" },
  "pi/session/fork": { scope: "session_write", reach: "any" },
  "pi/session/navigate": { scope: "session_write", reach: "any" },
  "pi/session/rename": { scope: "session_write", reach: "any" },
  "pi/session/delete": { scope: "session_write", reach: "any" },
  "pi/session/move": { scope: "session_write", reach: "any" },
  "pi/session/close": { scope: "session_write", reach: "any" },
  "pi/session/compact": { scope: "session_write", reach: "any" },
  "pi/model/set": { scope: "session_write", reach: "any" },
  "pi/thinking/set": { scope: "session_write", reach: "any" },
  "pi/transcribe/begin": { scope: "session_write", reach: "any" },
  // Dictation sends a chunk every few hundred milliseconds. Counted, not
  // written per call: two minutes of speech is one audit row, not four hundred.
  "pi/transcribe/chunk": { scope: "session_write", reach: "any", audit: "summary" },
  "pi/transcribe/end": { scope: "session_write", reach: "any" },
  "pi/transcribe/cancel": { scope: "session_write", reach: "any" },

  // ----------------------------------------------------------- approval ---
  "pi/ui/response": { scope: "approval", reach: "any" },

  // ------------------------------------------------------ work control ---
  "pi/worker/prepare": { scope: "work_control", reach: "any" },
  "pi/worker/restart": { scope: "work_control", reach: "any" },
  "pi/worker/stop": { scope: "work_control", reach: "any" },
  "tasks/stop": { scope: "work_control", reach: "any" },
  "pi/task/stop": { scope: "work_control", reach: "any" },
  "agents/runs/stop": { scope: "work_control", reach: "any" },
  "agents/worktree/remove": { scope: "work_control", reach: "any" },

  // ----------------------------------------------------------- settings ---
  "pi/settings/set": { scope: "settings", reach: "any" },
  "pi/keybindings/set": { scope: "settings", reach: "any" },
  "pi/prefs/set": { scope: "settings", reach: "any" },
  "pi/project/add": { scope: "settings", reach: "any" },
  "pi/project/remove": { scope: "settings", reach: "any" },
  "pi/project/reorder": { scope: "settings", reach: "any" },
  "pi/project/trust": { scope: "settings", reach: "any" },
  // ---------------------------------------------------------- execution ---
  // Running something this machine can execute. `mcp/call` runs a configured
  // server's tool; the project environment helpers run the command a project
  // was given. Granting `settings` alone lets a connection describe those
  // things without being able to run them.
  "mcp/call": { scope: "execution", reach: "any" },
  "pi/project/env/set": { scope: "execution", reach: "any" },
  "pi/project/env/test": { scope: "execution", reach: "any" },
  "pi/project/env/refresh": { scope: "execution", reach: "any" },
  "pi/providers/login/start": { scope: "settings", reach: "any" },
  "pi/providers/login/answer": { scope: "settings", reach: "any" },
  "pi/providers/login/cancel": { scope: "settings", reach: "any" },
  "pi/providers/logout": { scope: "settings", reach: "any" },
  "pi/setup/complete": { scope: "settings", reach: "any" },
  "mcp/save": { scope: "settings", reach: "any" },
  "mcp/remove": { scope: "settings", reach: "any" },
  "mcp/inspect": { scope: "settings", reach: "any" },
  "mcp/ping": { scope: "settings", reach: "any" },
  "mcp/disconnect": { scope: "settings", reach: "any" },
  "mcp/auth/start": { scope: "settings", reach: "any" },
  "mcp/auth/complete": { scope: "settings", reach: "any" },
  "mcp/auth/logout": { scope: "settings", reach: "any" },
  "mcp/import/apply": { scope: "settings", reach: "any" },
  "agents/validate": { scope: "settings", reach: "any" },
  "agents/save": { scope: "settings", reach: "any" },
  "agents/delete": { scope: "settings", reach: "any" },
  "agents/set-default": { scope: "settings", reach: "any" },
  "agents/set-policy": { scope: "settings", reach: "any" },
  "agents/builtin/set-model": { scope: "settings", reach: "any" },
  "agents/builtin/set-instructions": { scope: "settings", reach: "any" },
  "agents/namer/qualify": { scope: "settings", reach: "any" },
  // The private variable overlay a shell or terminal hands down. A page,
  // local or not, must never be able to repoint a worker's environment.
  "pi/host/environment": { scope: "settings", reach: "native", refusal: NATIVE_ENVIRONMENT_REFUSAL },
  // Host → worker plumbing that happens to share the client vocabulary.
  "agents/sync": { scope: "settings", reach: "native", refusal: NATIVE_SYNC_REFUSAL },

  // ----------------------------------------------------------- features ---
  "feature/list": { scope: "features", reach: "any" },
  "feature/set": { scope: "features", reach: "any" },
  "web-search/status": { scope: "features", reach: "any" },
  "web-search/configure": { scope: "features", reach: "any" },

  // -------------------------------------------------------- diagnostics ---
  "pi/logs/query": { scope: "diagnostics", reach: "any" },
  "pi/logs/content": { scope: "diagnostics", reach: "any" },
  "pi/logs/stats": { scope: "diagnostics", reach: "any" },
  "pi/logs/clear": { scope: "diagnostics", reach: "any" },
  // The inventory a phone can read is the same redacted, host-built one a
  // desktop reads (RP-3). What a remote caller must not do is *feed* it.
  "resource/snapshot": { scope: "diagnostics", reach: "any" },
  "resource/history": { scope: "diagnostics", reach: "any" },
  "resource/export": { scope: "diagnostics", reach: "any" },
  "resource/report": { scope: "diagnostics", reach: "native", refusal: NATIVE_REPORT_REFUSAL },
  // Host → its own already-live workers (RP-6). It is in this table because
  // every method is, and it is `native` for the same reason `agents/sync` is:
  // nothing outside this machine's app may ask a worker what it is holding.
  "pi/worker/retained-stores": { scope: "diagnostics", reach: "native", refusal: NATIVE_SYNC_REFUSAL },
  // Host → its own already-live workers (RP-4): releasing an idle session's
  // runtime, and reading what each loaded session is holding. Both are the
  // app managing its own runtimes on this machine, never a client's call.
  "pi/session/unload": { scope: "work_control", reach: "native", refusal: NATIVE_SYNC_REFUSAL },
  "pi/worker/safety": { scope: "diagnostics", reach: "native", refusal: NATIVE_SYNC_REFUSAL },
  "pi/worker/retire": { scope: "work_control", reach: "native", refusal: NATIVE_SYNC_REFUSAL },

  // ------------------------------------------------------------- device ---
  "pi/push/config": { scope: "device", reach: "any" },
  "pi/push/subscribe": { scope: "device", reach: "any" },
  "pi/push/unsubscribe": { scope: "device", reach: "any" },
  "pi/push/test": { scope: "device", reach: "any" },
} satisfies Record<ClientMethod, MethodPolicy>;

/** The table's row for a method, or `undefined` for anything it does not know. */
export function methodPolicy(method: string): MethodPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(METHOD_POLICY, method)
    ? (METHOD_POLICY as Record<string, MethodPolicy>)[method]
    : undefined;
}

/** Every method the table knows, for inventory tests and audit sanitisation. */
export const POLICED_METHODS: readonly string[] = Object.keys(METHOD_POLICY);

/**
 * Which scope owns each host → client notification.
 *
 * Compiler-complete for the same reason the request table is: a new
 * notification must decide who may hear it, and a partial switch would
 * silently keep sending a narrowed connection something it may not read.
 * Transcript admission is a separate, earlier filter and is unchanged.
 */
export const NOTIFICATION_SCOPE = {
  "session/update": "read",
  "pi/ui/request": "read",
  "pi/ui/event": "read",
  "pi/extension/message": "read",
  "pi/worker/status": "read",
  "pi/session/attention": "read",
  "pi/session/seen": "read",
  "pi/project/updated": "read",
  "pi/project/trust_request": "read",
  "pi/project/trust_resolved": "read",
  "pi/project/env/changed": "settings",
  "pi/packages/progress": "settings",
  "pi/providers/login/event": "settings",
  "pi/logs/append": "diagnostics",
  "pi/prefs/updated": "read",
  "agents/updated": "read",
  "agents/run": "read",
  "agents/event": "read",
  "agents/beam/choose-model": "read",
  "mcp/changed": "read",
  "resource/refresh_request": "diagnostics",
  // Worker → host only, and dropped before broadcast: the scope is here
  // because the table is compiler-complete, not because a client hears it.
  "pi/resource/process": "diagnostics",
  "tasks/update": "read",
} satisfies Record<keyof HostNotifications, MethodScope>;

/** The scope that owns a notification, or `undefined` for an unknown method. */
export function notificationScope(method: string): MethodScope | undefined {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_SCOPE, method)
    ? (NOTIFICATION_SCOPE as Record<string, MethodScope>)[method]
    : undefined;
}
