import { storageKey, type SessionAgentInfo } from "@lasercode/protocol";

export type SessionKindTab = "chat" | "code";

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

function read(): Partial<Record<SessionKindTab, string>> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SESSION_TAB_MEMORY_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record["chat"] === "string" ? { chat: record["chat"] } : {}),
      ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    };
  } catch {
    return {};
  }
}

export function rememberedSessionForTab(tab: SessionKindTab): string | undefined {
  return read()[tab];
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

export function rememberSessionForTab(tab: SessionKindTab, path: string): void {
  const current = read();
  if (current[tab] === path) return;
  try {
    globalThis.localStorage?.setItem(SESSION_TAB_MEMORY_KEY, JSON.stringify({ ...current, [tab]: path }));
  } catch {
    /* private mode / quota: tab switching falls back to the newest row */
  }
}
