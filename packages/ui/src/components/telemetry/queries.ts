/**
 * Session telemetry and git-change reads for the monitor column.
 * Data, not chrome — `TelemetryPanel` only paints.
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectChanges, SessionTelemetry, SessionUpdateParams, WorkspaceShape } from "@lasercode/protocol";

import { personFacingChangesError } from "@/source-control/errors.js";
import {
  bindWorkspaceShapeRequest,
  readWorkspaceShape,
} from "@/source-control/workspace-shape.js";
import { useLaserStable, useLaserState } from "@/runtime";

import { filesErrorText, type FilesStatus } from "./format.js";

export type TelemetryQueryStatus = "idle" | "loading" | "ready" | "error";

export function useSessionTelemetry(): { status: TelemetryQueryStatus; telemetry?: SessionTelemetry } {
  const { client } = useLaserStable();
  const path = useLaserState((s) => s.current);
  const [state, setState] = useState<{ status: TelemetryQueryStatus; telemetry?: SessionTelemetry }>({
    status: "idle",
  });
  useEffect(() => {
    if (!path) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void client.request("pi/session/telemetry", { path }).then(
      (result) => {
        if (!cancelled) setState({ status: "ready", telemetry: result });
      },
      (error: unknown) => {
        if (!cancelled) {
          const raw = error instanceof Error ? error.message.trim() : "";
          if (raw) console.warn("session telemetry:", raw);
          setState({ status: "error" });
        }
      },
    );
    const unsubscribe = client.subscribe((method, params) => {
      if (method !== "session/update") return;
      const update = params as SessionUpdateParams;
      if (update.sessionPath !== path || !update.telemetry) return;
      setState({ status: "ready", telemetry: update.telemetry });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, path]);
  return state;
}

/**
 * Git numstat for the session scope. `refreshKey` is bumped on settle and on
 * an explicit refresh — not on every telemetry revision (streaming records
 * would otherwise `git diff` per repository per appended line).
 */
export function useSessionChanges(
  path: string | undefined,
  cwd: string | undefined,
  refreshKey: number,
): { status: FilesStatus; changes?: ProjectChanges; message?: string } {
  const { client } = useLaserStable();
  const [state, setState] = useState<{ status: FilesStatus; changes?: ProjectChanges; message?: string }>({
    status: "idle",
  });
  useEffect(() => {
    if (!path || !cwd) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void client.request("pi/project/changes", { cwd, path, scope: "session" }).then(
      (result) => {
        if (!cancelled) setState({ status: "ready", changes: result });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: personFacingChangesError(error, filesErrorText()),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, path, cwd, refreshKey]);
  return state;
}

export type WorkspaceShapeStatus = "idle" | "loading" | "ready" | "error";

/**
 * Workspace shape for the current project. Shares the source-control reader
 * cache with the overlay: one `pi/project/workspace` per cwd, and again only
 * when `refreshKey` changes.
 */
export function useWorkspaceShape(
  cwd: string | undefined,
  refreshKey = 0,
): { status: WorkspaceShapeStatus; shape?: WorkspaceShape } {
  const stable = useLaserStable() as { client?: { request: (method: "pi/project/workspace", params: { cwd: string; rescan?: boolean }) => Promise<WorkspaceShape> } };
  const client = stable.client;
  const [state, setState] = useState<{ status: WorkspaceShapeStatus; shape?: WorkspaceShape }>({
    status: "idle",
  });
  const prevRefresh = useRef(refreshKey);

  useEffect(() => {
    if (!client) return;
    bindWorkspaceShapeRequest((params) => client.request("pi/project/workspace", params));
  }, [client]);

  useEffect(() => {
    if (!cwd || !client) {
      setState({ status: "idle" });
      return;
    }
    const rescan = prevRefresh.current !== refreshKey;
    prevRefresh.current = refreshKey;
    let cancelled = false;
    setState((current) => {
      if (current.shape && !rescan) return current;
      return current.shape ? { status: "loading", shape: current.shape } : { status: "loading" };
    });
    void readWorkspaceShape(cwd, rescan ? { rescan: true } : undefined).then(
      (shape) => {
        if (!cancelled) setState({ status: "ready", shape });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, cwd, refreshKey]);
  return state;
}
