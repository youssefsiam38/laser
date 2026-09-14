import { storageKey, type SessionAgentInfo } from "@lasercode/protocol";

export type SessionKindTab = "chat" | "code";

/**
 * Where the main destination is remembered between launches.
 *
 * `main-destination-controller.ts` is the only reader and the only writer of
 * this key, and its `DestinationMemory` (`{ v: 2, tab, chat?, code }`) is the
 * only shape it holds. This module used to keep a second pair of accessors
 * over a flat `{ chat, code }` of session paths; one write through them turned
 * `code` back into a string and cost the person the destination they left.
 * An older flat value left on a machine is not read as memory: the controller
 * migrates the `chat` path out of it and takes the rest from the pre-controller
 * project/session keys.
 */
export const SESSION_TAB_MEMORY_KEY = storageKey("session-tab-last");
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
