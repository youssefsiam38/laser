import { isChatWorkspaceCwd, type SessionKind, type SessionSummary } from "@lasercode/protocol";
import type { AppState, SessionView } from "../store.js";
import { mergeSessions } from "./threadList.js";
import { sessionKindFor } from "../agents/model.js";

/** Draft text and model choices are deliberately not work: reuse keeps them. */
export function isUnstartedSession(view: SessionView): boolean {
  return view.hydrated && view.state.messageCount === 0 && view.state.pendingMessageCount === 0
    && !view.running && !view.state.isStreaming && !view.state.isCompacting && !view.goal && !view.history?.hasHistory
    && view.queue.steering.length === 0 && view.queue.followUp.length === 0 && view.dialogs.length === 0
    && view.blocks.every((block) => block.kind === "notice")
    && !view.entries.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      // A completed/cleared goal is history too, even without ordinary messages.
      const item = entry as { type?: string; customType?: string };
      return item.type === "message" || item.type === "custom_message"
        || (item.type === "custom" && item.customType === "goal-state");
    });
}

export interface NewSessionOptions {
  /** The definition the session runs; omitted means the default agent. */
  agentName?: string;
  /**
   * `"chat"` starts a plain conversation: no definition, no project, the
   * Chat workspace (`docs/plain-chat.md`). The protocol refuses it beside an
   * `agentName`, because a Chat session runs no agent at all.
   */
  sessionKind?: SessionKind;
  /**
   * `false` leaves the main view where it is: the session is opened and
   * returned but never selected. A scoped surface starts its sessions this
   * way (runtime/LaserProvider.tsx `LaserThreadScope`).
   */
  select?: boolean;
}

/** Internal handoff policy used by the main destination and thread-list runtime. */
export interface SessionLaunchOptions extends NewSessionOptions {
  landing?: boolean;
}

interface SessionLauncherDeps {
  state(): AppState;
  archived(path: string): boolean;
  /** Must reject on failure: an unknown catalog is not an empty catalog. */
  refresh(): Promise<void>;
  /** `select: false` loads without making the session current. */
  open(path: string, options?: { select?: boolean }): Promise<void>;
  select(path: string): void;
  create(cwd: string, options: SessionLaunchOptions): Promise<string>;
  holdLanding(path: string): void;
  releaseLanding(path: string): void;
  /**
   * The definition a name stands for, with `undefined` resolved to the default
   * agent. Applied to the request and to every catalog row alike, so an empty
   * session is reused only by a request for the same agent: a blank project
   * session must never answer a request for another agent, or the reverse.
   */
  resolveAgent?(name: string | undefined): string | undefined;
}

/** The launcher every New session button, shortcut and the thread-list adapter share. */
export type SessionLauncher = (cwd: string, options?: SessionLaunchOptions) => Promise<string>;

const agentNameOf = (summary: SessionSummary): string | undefined => summary.agent?.agentName;

/**
 * Shared by every New session button, shortcut and the thread-list adapter.
 * This is navigation policy, not a change to explicit host creation/fork APIs.
 */
export function createSessionLauncher(deps: SessionLauncherDeps): SessionLauncher {
  const pending = new Map<string, { work: Promise<string>; selected?: Promise<string>; landing: { value: boolean } }>();
  const resolve = deps.resolveAgent ?? ((name) => name);
  return (cwd, options = {}) => {
    // A Chat session runs no definition, so the agent a request resolves to
    // says nothing about it: its kind is the whole of its identity.
    const chat = options.sessionKind === "chat";
    const wanted = chat ? undefined : resolve(options.agentName);
    const quiet = options.select === false;
    const key = `${cwd} ${chat ? "chat" : wanted ?? ""}`;
    const resultFor = (entry: { work: Promise<string>; selected?: Promise<string>; landing: { value: boolean } }) => {
      if (options.landing) entry.landing.value = true;
      if (quiet) return entry.work;
      // Allocation is shared, navigation is the caller's choice. A sidebar +
      // racing the bubble must select the same session, never allocate two.
      return entry.selected ??= entry.work.then((path) => { deps.select(path); return path; });
    };
    const existing = pending.get(key);
    if (existing) return resultFor(existing);
    const landing = { value: options.landing === true };
    const work = (async () => {
      await deps.refresh();
      const state = deps.state();
      // Inside the Chat workspace an empty conversation is reusable wherever
      // its own folder is, not only at the exact directory asked for.
      const workspace = isChatWorkspaceCwd(cwd, state.agents.snapshot?.workspaces) ? ("chat" as const) : undefined;
      const candidates = mergeSessions(state.sessions, state.open)
        .filter((session) => (session.cwd === cwd || (workspace !== undefined && sessionKindFor(session, state.agents.snapshot) === workspace))
          && !session.parentPath && session.agent?.kind !== "child"
          && !deps.archived(session.path)
          && (chat
            ? sessionKindFor(session, state.agents.snapshot) === "chat"
            : sessionKindFor(session, state.agents.snapshot) === "project" && resolve(agentNameOf(session)) === wanted)
          && session.messageCount === 0 && !session.firstMessage
          // An attention mark is not a reason to skip a session that has never
          // been prompted: an unwritten row can carry a stale "unread" stamp
          // (M13-T47), and the hydrated `isUnstartedSession` check below is
          // the proof of emptiness, not the catalog's mood. Only a session that
          // genuinely wants a person — an error or a question — is left alone.
          && !(session.attention === "error" || session.attention === "waiting_for_input"))
        .sort((a, b) => Number(b.path === state.current) - Number(a.path === state.current)
          || b.modifiedAt.localeCompare(a.modifiedAt));
      for (const candidate of candidates) {
        let view = deps.state().open[candidate.path];
        let heldForLanding = false;
        if (!view?.hydrated) {
          // The probe load itself acquires membership. Hold it across the
          // synchronous store publications until its caller lands the path.
          if (landing.value) {
            deps.holdLanding(candidate.path);
            heldForLanding = true;
          }
          try {
            await deps.open(candidate.path, { select: false });
            view = deps.state().open[candidate.path];
          } catch (error) {
            if (heldForLanding) deps.releaseLanding(candidate.path);
            throw error;
          }
        }
        if (view && isUnstartedSession(view) && !deps.archived(candidate.path)) return candidate.path;
        if (heldForLanding) deps.releaseLanding(candidate.path);
      }
      return deps.create(cwd, {
        ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
        ...(options.sessionKind !== undefined ? { sessionKind: options.sessionKind } : {}),
        select: false,
        ...(landing.value ? { landing: true } : {}),
      });
    })();
    const entry = { work: work.finally(() => pending.delete(key)), landing };
    pending.set(key, entry);
    return resultFor(entry);
  };
}
