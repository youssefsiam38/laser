import type { SessionSummary } from "@lasercode/protocol";
import type { AppState, SessionView } from "../store.js";
import { mergeSessions } from "./threadList.js";

/** Draft text and model choices are deliberately not work: reuse keeps them. */
export function isUnstartedSession(view: SessionView): boolean {
  return view.hydrated && view.state.messageCount === 0 && view.state.pendingMessageCount === 0
    && !view.running && !view.state.isStreaming && !view.state.isCompacting && !view.goal
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
   * `false` leaves the main view where it is: the session is opened and
   * returned but never selected. A scoped surface (the Beam bubble) starts
   * its sessions this way (runtime/LaserProvider.tsx `LaserThreadScope`).
   */
  select?: boolean;
}

interface SessionLauncherDeps {
  state(): AppState;
  archived(path: string): boolean;
  /** Must reject on failure: an unknown catalog is not an empty catalog. */
  refresh(): Promise<void>;
  /** `select: false` loads without making the session current. */
  open(path: string, options?: { select?: boolean }): Promise<void>;
  select(path: string): void;
  create(cwd: string, options: NewSessionOptions): Promise<string>;
  /**
   * The definition a name stands for, with `undefined` resolved to the default
   * agent. Applied to the request and to every catalog row alike, so an empty
   * session is reused only by a request for the same agent: a blank Beam chat
   * must never become someone's project session, or the reverse.
   */
  resolveAgent?(name: string | undefined): string | undefined;
}

/** The launcher every New session button, shortcut and the thread-list adapter share. */
export type SessionLauncher = (cwd: string, options?: NewSessionOptions) => Promise<string>;

const agentNameOf = (summary: SessionSummary): string | undefined => summary.agent?.agentName;

/**
 * Shared by every New session button, shortcut and the thread-list adapter.
 * This is navigation policy, not a change to explicit host creation/fork APIs.
 */
export function createSessionLauncher(deps: SessionLauncherDeps): SessionLauncher {
  const pending = new Map<string, Promise<string>>();
  const resolve = deps.resolveAgent ?? ((name) => name);
  return (cwd, options = {}) => {
    const wanted = resolve(options.agentName);
    const quiet = options.select === false;
    const key = `${cwd} ${wanted ?? ""}${quiet ? " quiet" : ""}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      await deps.refresh();
      const state = deps.state();
      const candidates = mergeSessions(state.sessions, state.open)
        .filter((session) => session.cwd === cwd && !session.parentPath && session.agent?.kind !== "child"
          && !deps.archived(session.path)
          && resolve(agentNameOf(session)) === wanted
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
        if (!view?.hydrated) {
          // Catalog counts alone cannot prove emptiness (goals, live work, stale scans).
          if (quiet) await deps.open(candidate.path, { select: false });
          else await deps.open(candidate.path);
          view = deps.state().open[candidate.path];
        }
        if (view && isUnstartedSession(view) && !deps.archived(candidate.path)) {
          if (!quiet) deps.select(candidate.path);
          return candidate.path;
        }
      }
      return deps.create(cwd, {
        ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
        ...(quiet ? { select: false } : {}),
      });
    })();
    const tracked = work.finally(() => pending.delete(key));
    pending.set(key, tracked);
    return tracked;
  };
}
