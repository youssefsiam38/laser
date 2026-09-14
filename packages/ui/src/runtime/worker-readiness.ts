import type { ProjectInfo, SessionSummary } from "@lasercode/protocol";
import { useCallback, useEffect, useRef } from "react";
import { sessionsList, type SessionsListState } from "../components/shell/session-groups.js";
import type { HostClient } from "../client.js";
import type { AppState } from "../store.js";
import type { ArchiveStore } from "./threadList.js";

/** Intent only: mounting a catalog or a set of default-open groups is not intent. */
export function expandedProject(before: SessionsListState, after: SessionsListState): string | undefined {
  if (after.jump && after.jump.nonce !== before.jump?.nonce) return after.jump.cwd;
  for (const cwd of before.collapsed) if (!after.collapsed.has(cwd)) return cwd;
  return undefined;
}

export function canPrepareProject(cwd: string, projects: readonly ProjectInfo[], sessions: readonly SessionSummary[], archived: (path: string) => boolean): boolean {
  const project = projects.find((item) => item.cwd === cwd);
  // Archive visibility is client-local; the host alone owns trust admission.
  return !!project && sessions.some((session) => session.cwd === cwd && !archived(session.path));
}

interface WorkerReadinessOptions {
  currentProject: string | undefined;
  connection: AppState["connection"];
  sessionsLoaded: boolean;
  projects: readonly ProjectInfo[];
  client: Pick<HostClient, "request">;
  readState: () => AppState;
  archive: ArchiveStore;
}

/** One subscription for the main provider; default catalog selection is not intent. */
export function useWorkerReadiness({ currentProject, connection, sessionsLoaded, projects, client, readState, archive }: WorkerReadinessOptions) {
  // Capture restored memory before the provider's automatic project fallback.
  //
  // The remembered project is readable only once the environment is known
  // (RP-13), which is after this hook's first render: the descriptor is
  // delivered, the device is scoped to it and the destination is restored, and
  // only then does the connection open. So the restored project is adopted
  // whenever it arrives, up until the readiness controller starts.
  const memory = useRef(currentProject);
  const controller = useRef<ReturnType<typeof createWorkerReadiness> | undefined>(undefined);
  // Adopted during render, before any effect of this commit: the readiness
  // controller has not started, so nothing the app chose automatically can be
  // in `currentProject` yet — only what the person left behind.
  if (memory.current === undefined && controller.current === undefined) memory.current = currentProject;
  useEffect(() => {
    if (connection !== "open" || !sessionsLoaded || projects.length === 0) return;
    const readiness = createWorkerReadiness(
      (cwd) => client.request("pi/worker/prepare", { cwd }),
      (cwd) => canPrepareProject(cwd, projects, readState().sessions, (path) => archive.has(path)),
    );
    controller.current = readiness;
    if (memory.current) {
      readiness.want(memory.current);
      memory.current = undefined;
    }
    let previous = sessionsList.get();
    const unsubscribe = sessionsList.subscribe(() => {
      const next = sessionsList.get();
      const cwd = expandedProject(previous, next);
      previous = next;
      if (cwd) readiness.want(cwd);
    });
    return () => { unsubscribe(); readiness.dispose(); controller.current = undefined; };
  }, [archive, client, projects, readState, connection, sessionsLoaded]);
  return useCallback((cwd: string | undefined) => {
    if (!cwd) return;
    if (controller.current) controller.current.want(cwd);
    else memory.current = cwd;
  }, []);
}

/** One trailing intent, no hover handlers or background polling. */
export function createWorkerReadiness(prepare: (cwd: string) => Promise<unknown>, eligible: (cwd: string) => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    want(cwd: string) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (eligible(cwd)) void prepare(cwd).catch(() => {});
      }, 150);
    },
    dispose() { clearTimeout(timer); },
  };
}
