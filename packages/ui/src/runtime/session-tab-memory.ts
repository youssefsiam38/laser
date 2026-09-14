import { storageKey, type SessionAgentInfo } from "@lasercode/protocol";

export type SessionKindTab = "chat" | "code";

/**
 * Which of the two tabs was last shown.
 *
 * An enum, not a place: it names no project, session or machine, so it is one
 * of the few things that stays outside the environment namespace and follows a
 * person between environments (`device-storage.ts`, RP-13). The *destination*
 * behind each tab is a path, and that lives in the namespace.
 */
export const SESSIONS_TAB_STORAGE_KEY = storageKey("sessions-tab");

const normalized = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** Chat records are authoritative; root containment keeps pre-record sessions classifiable. */
export function sessionKindTab(
  session: { cwd: string; agent?: SessionAgentInfo | undefined },
  workspaces: { chat?: string | undefined },
): SessionKindTab {
  if (session.agent?.kind === "chat") return "chat";
  const root = workspaces.chat ? normalized(workspaces.chat) : "";
  const cwd = normalized(session.cwd);
  return root !== "" && (cwd === root || cwd.startsWith(`${root}/`)) ? "chat" : "code";
}

export function rememberedSessionsTab(): SessionKindTab {
  try {
    return globalThis.localStorage?.getItem(SESSIONS_TAB_STORAGE_KEY) === "chat" ? "chat" : "code";
  } catch {
    return "code";
  }
}

export function rememberSessionsTab(tab: SessionKindTab): void {
  try {
    globalThis.localStorage?.setItem(SESSIONS_TAB_STORAGE_KEY, tab);
  } catch {
    /* private mode / quota: the live destination remains authoritative */
  }
}
