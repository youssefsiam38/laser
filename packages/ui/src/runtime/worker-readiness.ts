import type { ProjectInfo, SessionSummary } from "@lasercode/protocol";
import type { SessionsListState } from "../components/shell/session-groups.js";

/** Intent only: mounting a catalog or a set of default-open groups is not intent. */
export function expandedProject(before: SessionsListState, after: SessionsListState): string | undefined {
  if (after.jump && after.jump.nonce !== before.jump?.nonce) return after.jump.cwd;
  for (const cwd of before.collapsed) if (!after.collapsed.has(cwd)) return cwd;
  return undefined;
}

export function canPrepareProject(cwd: string, projects: readonly ProjectInfo[], sessions: readonly SessionSummary[], archived: (path: string) => boolean): boolean {
  const project = projects.find((item) => item.cwd === cwd);
  return !!project && (project.trust === "trusted" || project.trust === "not_required")
    && sessions.some((session) => session.cwd === cwd && !archived(session.path));
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
