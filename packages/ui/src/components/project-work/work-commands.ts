"use client";
/**
 * The four Laser-owned commands, in one list, for both places that offer them:
 * the composer's `/` popover and the command palette (D-355, "Elements and
 * the bar"). They create or open a workspace destination; they never become
 * engine commands and nothing is sent to a model.
 */
import { useCallback, useMemo } from "react";
import type { ProjectWorkKind } from "@lasercode/protocol";

import { useLaserStable, useLaserState } from "@/runtime";
import { landingWorkspaceOf } from "@/runtime/main-destination";
import type { AppState } from "@/store";
import { KIND_LABEL } from "@/project-work/vocabulary";

import { startProjectWork } from "./create-work.js";

/** `/task` is deliberately absent: a Task is created in a plan or in Create. */
export const WORK_COMMAND_KINDS: readonly ProjectWorkKind[] = ["spec", "research", "design", "plan"];

const DESCRIPTION: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "Start a spec from what you type after it",
  research: "Start research from the question you type after it",
  design: "Start a design from what you type after it",
  plan: "Start a plan — the text after it is the plan's own brief",
  task: "Start a task from the outcome you type after it",
};

export interface WorkCommand {
  kind: ProjectWorkKind;
  id: string;
  label: string;
  description: string;
  run(text: string): void;
}

/**
 * The project these commands land in: the open session's, or the project the
 * window is on. `undefined` in a projectless Chat, where the command asks.
 */
export function useCommandProject(): string | undefined {
  const { currentProject } = useLaserStable();
  // A scoped runtime can render this composer without the main window's
  // destination; the session's own directory answers just as well there.
  const destination = useLaserState((state) => state.destination as AppState["destination"] | undefined);
  const sessionCwd = useLaserState((state) => (state.current ? state.open[state.current]?.state.cwd : undefined));
  const landing = destination ? landingWorkspaceOf(destination) : undefined;
  if (landing?.kind === "chat") return undefined;
  return sessionCwd ?? (landing?.kind === "project" ? landing.cwd : currentProject);
}

export function useProjectWorkCommands(): WorkCommand[] {
  const { actions } = useLaserStable();
  const cwd = useCommandProject();
  const sessionId = useLaserState((state) => (state.current ? state.open[state.current]?.state.id : undefined));

  const run = useCallback(
    (kind: ProjectWorkKind, text: string) => {
      void startProjectWork({
        kind,
        text,
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
        toast: actions.toast,
      });
    },
    [actions, cwd, sessionId],
  );

  return useMemo(
    () =>
      WORK_COMMAND_KINDS.map((kind) => ({
        kind,
        id: kind,
        label: `/${kind}`,
        description: DESCRIPTION[kind],
        run: (text: string) => run(kind, text),
      })),
    [run],
  );
}

export { KIND_LABEL };
