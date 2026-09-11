/**
 * Two ways back to the chat that always work (M13-T50).
 *
 * The chat can be covered by the agent map (in the main column or
 * fullscreen), by the workbench (Settings, Logs, Agents), by the fleet sheet
 * and, below desktop width, by the sessions and telemetry sheets. All of that
 * is shell state — none of it lives in the store or the runtime — so the shell
 * owns the two verbs that clear it:
 *
 * - `showChat`: a session chosen in the sessions list is a navigation to that
 *   chat; nothing may keep covering it. Leaves every covering surface and lets
 *   the selection itself decide which session shows.
 * - `returnToChat`: the logo, "back to my chat" from anywhere. `showChat`,
 *   then the last opened session — the current one when there is one,
 *   otherwise the one remembered for the current project, otherwise the
 *   project's new-session state. Nothing is created by the click.
 *
 * The top bar's map toggle keeps toggling; it is simply no longer the only
 * way back. Tested through test/shell/chat-navigation.test.tsx.
 */
import type { SessionSummary } from "@lasercode/protocol";
import { useCallback } from "react";

import { mapUi } from "@/components/agents/map";
import { useWorkbench } from "@/components/workbench";
import { closeFleetSheet } from "@/fleet";
import { useLaserStable, useLaserState } from "@/runtime";
import { SESSION_STORAGE_KEY } from "@/runtime/LaserProvider";

import { errorText } from "./shell-context.js";

/**
 * The session the app remembers for `cwd` — the one the runtime writes under
 * `SESSION_STORAGE_KEY` whenever a session becomes current — provided it is
 * still in the catalog. A deleted or unknown session is not a destination.
 */
export function rememberedSessionFor(cwd: string | undefined, sessions: readonly SessionSummary[]): string | undefined {
  if (!cwd) return undefined;
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SESSION_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const path = (parsed as Record<string, unknown>)[cwd];
    return typeof path === "string" && sessions.some((session) => session.path === path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export interface ChatNavigation {
  /** Leave everything that covers the chat; the selection decides which session shows. */
  showChat(): void;
  /** Leave everything that covers the chat and show the last opened session. */
  returnToChat(): void;
}

/**
 * Built once by the shell frame, which owns the compact layouts' sheets and
 * hands their close over as `closeSheets`. Must be called under
 * `WorkbenchProvider` and `LaserProvider`.
 */
export function useChatNavigation({ closeSheets }: { closeSheets(): void }): ChatNavigation {
  const workbench = useWorkbench();
  const { actions } = useLaserStable();
  const destination = useLaserState((s) => s.destination);

  const showChat = useCallback(() => {
    mapUi.setFullscreen(false);
    mapUi.setOpen(false);
    closeFleetSheet();
    closeSheets();
    workbench.close();
  }, [closeSheets, workbench]);

  const returnToChat = useCallback(() => {
    showChat();
    if (destination.path !== undefined && destination.phase === "ready") return;
    actions.goTab(destination.tab).catch((error: unknown) => actions.toast("error", errorText(error)));
  }, [actions, destination, showChat]);

  return { showChat, returnToChat };
}
