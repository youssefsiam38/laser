/**
 * Session telemetry and git-change reads for the monitor column.
 * Data, not chrome — `TelemetryPanel` only paints.
 */
import { useEffect, useState } from "react";
import type { ProjectChanges, SessionTelemetry, SessionUpdateParams } from "@lasercode/protocol";

import { personFacingChangesError } from "@/source-control/errors.js";
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
