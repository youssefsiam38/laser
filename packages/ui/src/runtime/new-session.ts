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

interface SessionLauncherDeps {
  state(): AppState;
  archived(path: string): boolean;
  /** Must reject on failure: an unknown catalog is not an empty catalog. */
  refresh(): Promise<void>;
  open(path: string): Promise<void>;
  select(path: string): void;
  create(cwd: string): Promise<string>;
}

/**
 * Shared by every New session button, shortcut and the thread-list adapter.
 * This is navigation policy, not a change to explicit host creation/fork APIs.
 */
export function createSessionLauncher(deps: SessionLauncherDeps): (cwd: string) => Promise<string> {
  const pending = new Map<string, Promise<string>>();
  return (cwd) => {
    const existing = pending.get(cwd);
    if (existing) return existing;
    const work = (async () => {
      await deps.refresh();
      const state = deps.state();
      const candidates = mergeSessions(state.sessions, state.open)
        .filter((session) => session.cwd === cwd && !session.parentPath && !deps.archived(session.path)
          && session.messageCount === 0 && !session.firstMessage
          && (!session.attention || session.attention === "idle"))
        .sort((a, b) => Number(b.path === state.current) - Number(a.path === state.current)
          || b.modifiedAt.localeCompare(a.modifiedAt));
      for (const candidate of candidates) {
        let view = deps.state().open[candidate.path];
        if (!view?.hydrated) {
          // Catalog counts alone cannot prove emptiness (goals, live work, stale scans).
          await deps.open(candidate.path);
          view = deps.state().open[candidate.path];
        }
        if (view && isUnstartedSession(view) && !deps.archived(candidate.path)) {
          deps.select(candidate.path);
          return candidate.path;
        }
      }
      return deps.create(cwd);
    })();
    const tracked = work.finally(() => pending.delete(cwd));
    pending.set(cwd, tracked);
    return tracked;
  };
}
