"use client";
/**
 * Which conversation an index build would belong to (M21-T10/T13 follow-up).
 *
 * An index build is a Command, and a Command belongs to a session: that is
 * where its row, its progress by files and its Stop live (D-328;
 * `docs/design-phase.md`, "Re-index"). So the window cannot start one from
 * nowhere — it has to name the conversation that will own it.
 *
 * The owner is this window's current conversation, and only when that
 * conversation belongs to the project being indexed. A worktree session
 * qualifies exactly like the project's own: the registry resolves both
 * directories to the same stable `projectId`, which is the whole point of
 * resolving a path rather than comparing one.
 *
 * When there is none, this returns the sentence the panel shows **instead of**
 * the button — never a button that starts work nobody can see, and never a
 * silently hidden control.
 */
import { useEffect, useState } from "react";

import { knownProjectWork, resolveProjectWork } from "@/project-work";
import { useLaserState } from "@/runtime";

/** What the Design tab says when no conversation could own a build. */
export const DESIGN_BUILD_NEEDS_SESSION_SENTENCE =
  "Building the index runs as a Command in a conversation, so you can watch it by files and stop it there. Open this project's conversation — or start one in it — and build the index from there.";

export type DesignBuildOwner = { sessionPath: string } | { refusal: string };

export function designBuildOwnerHasSession(owner: DesignBuildOwner): owner is { sessionPath: string } {
  return "sessionPath" in owner;
}

const REFUSED: DesignBuildOwner = { refusal: DESIGN_BUILD_NEEDS_SESSION_SENTENCE };

/**
 * One answer, and what it is an answer *about*.
 *
 * A resolution belongs to the directory it was made for and to the project it
 * was compared against — never to "the last thing this hook looked at". The
 * moment the window moves to another conversation, the old answer stops
 * applying, so it can never be read as this one's: an unresolved directory is
 * refused until it has resolved, not treated as whatever resolved before it.
 */
interface Resolution {
  /** The conversation's directory this was resolved for. */
  cwd: string;
  /** The project the panel was asking about when it was resolved. */
  forProjectId: string;
  /** What the directory resolved to, or undefined when it could not be. */
  projectId: string | undefined;
}

/**
 * The conversation that would own a build of this project, or why none would.
 *
 * `projectId` empty means the caller is not reading a project over the wire at
 * all (a test injecting its own access, the compact preview); there is nothing
 * to own then, and nothing is probed.
 */
export function useDesignBuildOwner(projectId: string): DesignBuildOwner {
  const current = useLaserState((state) => state.current);
  // Both places a directory can be known from: the open view is the exact one
  // this window is looking at, the catalog row is what it knows before the
  // transcript has loaded.
  const cwd = useLaserState((state) => {
    const path = state.current;
    if (!path) return undefined;
    return state.open[path]?.state.cwd ?? state.sessions.find((row) => row.path === path)?.cwd;
  });
  const [resolution, setResolution] = useState<Resolution | undefined>(undefined);

  useEffect(() => {
    if (projectId === "" || cwd === undefined) {
      setResolution(undefined);
      return;
    }
    // Already resolved on this device: no probe, no render after the fact.
    const known = knownProjectWork(cwd);
    if (known) {
      setResolution({ cwd, forProjectId: projectId, projectId: known.getSnapshot().projectId });
      return;
    }
    let cancelled = false;
    void resolveProjectWork(cwd).then((store) => {
      if (!cancelled) setResolution({ cwd, forProjectId: projectId, projectId: store?.getSnapshot().projectId });
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, projectId]);

  if (projectId === "" || !current || cwd === undefined) return REFUSED;
  // Only an answer about *this* conversation's directory counts. While a
  // directory has not resolved yet there is no owner: a build is not offered
  // on the strength of the conversation the window was on a moment ago.
  const resolved = resolution?.cwd === cwd && resolution.forProjectId === projectId ? resolution.projectId : undefined;
  const known = knownProjectWork(cwd)?.getSnapshot().projectId ?? resolved;
  // A conversation in another project may read this design and comment on it,
  // but it cannot own this project's work (the leap, "Cross-session mentions
  // and context"); the worker refuses it too, and this is why it is never
  // offered. An unresolved directory is `undefined` here, and `undefined` is
  // not this project either — so the refusal covers both.
  if (known !== projectId) return REFUSED;
  return { sessionPath: current };
}
