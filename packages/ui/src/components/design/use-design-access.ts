"use client";
/**
 * The wire behind the Design tab (M21-T13).
 *
 * T11 drew every design surface against an injected `DesignIndexAccess` and
 * left honest pending states where the wire was missing. This is the wire: six
 * `design/*` methods, answered by the project's own worker through the host.
 *
 * What it owns, and nothing else:
 *
 * - **One read, repeated only while something is running.** The index is read
 *   once per project and again after a review or a build; while a build is in
 *   flight it is polled for its progress — by files, never a percentage — and
 *   the polling stops the moment the build does.
 * - **Refusals as sentences.** Every failure becomes the message the host or
 *   the worker wrote, so the panel shows the reason rather than "failed".
 * - **A connection that may not write says so once.** Review, Re-index and
 *   grounding are `project_write`; a connection without it gets the access
 *   object with those verbs absent and one sentence saying why — never a
 *   button that fails.
 * - **A build always names the conversation that owns it.** An index build is
 *   a Command, and a Command lives in a session's fleet group: this passes the
 *   session that will own it, and when none of this window's conversations
 *   can, it hands the panel the sentence to show in the button's place rather
 *   than starting work nobody could watch or stop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientRequests, DesignIndex, DesignIndexCommand } from "@lasercode/protocol";

import { closeWorkspace } from "@/project-work";
import { useCapability, useLaserStable } from "@/runtime";

import { designBuildOwnerHasSession, useDesignBuildOwner } from "./build-owner.js";
import type { DesignIndexAccess, DesignIndexState, DesignReviewVerb } from "./DesignIndexPanel.js";

type Request = <M extends keyof ClientRequests>(method: M, params: ClientRequests[M]["params"]) => Promise<ClientRequests[M]["result"]>;

/** How often a running build is asked where it is. */
const POLL_MS = 600;

/** What the panel says when this window has no connection to read through. */
export const DISCONNECTED_SENTENCE =
  "This window is not connected to the app right now, so this project's design system cannot be read. It comes back on its own as soon as the connection does.";

export interface DesignWorkspaceAccess {
  index: DesignIndex | undefined;
  access: DesignIndexAccess;
  /** Ground a page in context. Absent when this connection cannot write. */
  ground?: ((params: Omit<ClientRequests["design/host/ground"]["params"], "projectId">) => Promise<ClientRequests["design/host/ground"]["result"]>) | undefined;
  /** Rebuild one sketch document as a tree. Absent without the capability. */
  groundSketchDocument?:
    | ((params: Omit<ClientRequests["design/sketch/ground"]["params"], "projectId">) => Promise<ClientRequests["design/sketch/ground"]["result"]>)
    | undefined;
  /** Read again after something else changed the project's files. */
  refresh: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "The design index could not be read from here.";
}

export function useDesignAccess(projectId: string, options: { sessionPath?: string | undefined } = {}): DesignWorkspaceAccess {
  const derivedOwner = useDesignBuildOwner(options.sessionPath === undefined ? projectId : "");
  const owner = options.sessionPath !== undefined ? { sessionPath: options.sessionPath } : derivedOwner;
  const ownerPath = designBuildOwnerHasSession(owner) ? owner.sessionPath : undefined;
  const ownerRefusal = designBuildOwnerHasSession(owner) ? undefined : owner.refusal;
  const { client } = useLaserStable() as { client?: { request: Request } };
  // The reads depend on *having* a client, not on its identity: a provider
  // that hands out a fresh object each render must not restart them.
  const clientRef = useRef<{ request: Request } | undefined>(client);
  clientRef.current = client;
  const hasClient = client !== undefined;
  const canWrite = useCapability("design/index/review", { presentation: "explained" });
  const writable = canWrite.state === "available";

  const [state, setState] = useState<DesignIndexState>({ kind: "loading" });
  const [commands, setCommands] = useState<DesignIndexCommand[]>([]);
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((value) => value + 1), []);

  const running = useMemo(() => commands.find((command) => command.running), [commands]);

  useEffect(() => {
    const request = clientRef.current?.request;
    if (projectId === "") return;
    if (!request) {
      setState({ kind: "unavailable", detail: DISCONNECTED_SENTENCE });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (): Promise<void> => {
      try {
        const answer = await request("design/index/get", { projectId });
        if (cancelled) return;
        setCommands(answer.commands);
        setState(answer.state === "ready" && answer.index ? { kind: "ready", index: answer.index } : { kind: "absent", detail: answer.detail ?? "" });
        if (answer.commands.some((command) => command.running)) timer = setTimeout(() => void read(), POLL_MS);
      } catch (error) {
        if (cancelled) return;
        setState({ kind: "error", message: messageOf(error) });
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [hasClient, projectId, epoch]);

  const review = useCallback(
    async (verb: DesignReviewVerb): Promise<{ ok: true } | { ok: false; message: string }> => {
      const request = clientRef.current?.request;
      if (!request) return { ok: false, message: "This window is not connected right now." };
      try {
        const answer = await request("design/index/review", {
          projectId,
          entryId: verb.entryId,
          action: verb.action,
          ...(verb.action === "rename" ? { name: verb.name } : {}),
          ...(verb.action === "merge" ? { intoEntryId: verb.intoId } : {}),
        });
        setState({ kind: "ready", index: answer.index });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    },
    [projectId],
  );

  const reindex = useCallback(async (): Promise<{ ok: true; commandId: string } | { ok: false; message: string }> => {
    const request = clientRef.current?.request;
    if (!request) return { ok: false, message: "This window is not connected right now." };
    // Never sent without one: the control that calls this is only offered when
    // a conversation can own the build.
    if (ownerPath === undefined) return { ok: false, message: ownerRefusal ?? "" };
    try {
      const answer = await request("design/index/build", {
        projectId,
        rebuild: false,
        sessionPath: ownerPath,
      });
      setCommands((current) => [...current.filter((command) => command.commandId !== answer.command.commandId), answer.command]);
      refresh();
      return { ok: true, commandId: answer.command.commandId };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }, [ownerPath, ownerRefusal, projectId, refresh]);

  const stopReindex = useCallback(
    (commandId: string): void => {
      const request = clientRef.current?.request;
      if (!request) return;
      void request("design/index/stop", { projectId, commandId })
        .then(() => refresh())
        .catch(() => refresh());
    },
    [projectId, refresh],
  );

  const ground = useCallback(
    async (params: Omit<ClientRequests["design/host/ground"]["params"], "projectId">) => {
      const request = clientRef.current?.request;
      if (!request) throw new Error("This window is not connected right now.");
      return await request("design/host/ground", { ...params, projectId });
    },
    [projectId],
  );

  const groundSketchDocument = useCallback(
    async (params: Omit<ClientRequests["design/sketch/ground"]["params"], "projectId">) => {
      const request = clientRef.current?.request;
      if (!request) throw new Error("This window is not connected right now.");
      return await request("design/sketch/ground", { ...params, projectId });
    },
    [projectId],
  );

  const access: DesignIndexAccess = useMemo(
    () => ({
      state,
      ...(writable ? { review, stopReindex } : {}),
      ...(writable && ownerPath !== undefined ? { reindex } : {}),
      ...(writable && ownerPath === undefined && ownerRefusal !== undefined
        ? {
            reindexRefusal: {
              sentence: ownerRefusal,
              // The way back to a conversation is the one the workspace
              // already has: closing it returns to the conversation, where a
              // session is opened or started as usual (D-355).
              act: { label: "Back to the conversation", run: () => closeWorkspace() },
            },
          }
        : {}),
      ...(running !== undefined
        ? {
            reindexing: {
              commandId: running.commandId,
              files: running.filesParsed,
              ...(running.filesFound > 0 ? { total: running.filesFound } : {}),
            },
          }
        : {}),
      ...(writable ? {} : { writeRefusal: canWrite.state === "explained" ? canWrite.explanation : "This connection can read this project's design system but not change it." }),
    }),
    [canWrite, ownerPath, ownerRefusal, reindex, review, running, state, stopReindex, writable],
  );

  return {
    index: state.kind === "ready" ? state.index : undefined,
    access,
    ...(writable ? { ground, groundSketchDocument } : {}),
    refresh,
  };
}
