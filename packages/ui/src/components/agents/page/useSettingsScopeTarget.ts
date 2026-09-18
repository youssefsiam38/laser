"use client";

import { useLayoutEffect, useMemo, useState } from "react";

import {
  useCommittedTargetLifetime,
  type CommittedTargetLease,
} from "@/components/settings/useCommittedTargetLifetime";
import { useLaserStable } from "@/runtime/LaserProvider";
import type { SettingsScopeState } from "@/runtime/settings-scope";

import type { AgentsScopeView } from "./model.js";
import { useRequest } from "./use-page-data.js";

export interface AgentsScopeTarget {
  scope: SettingsScopeState;
  view: AgentsScopeView;
  /** Neutral setup service for Global; exact project for Project/Effective. */
  routeCwd: string;
  projectCwd?: string | undefined;
}

/**
 * Commits one explicit Settings scope only after setup and environment
 * activation have both settled. While either is changing, callers render no
 * route-scoped children, so requests cannot leak from the previous target.
 */
export function useSettingsScopeTarget(
  scope: SettingsScopeState,
  projects: readonly string[],
): {
  target: AgentsScopeTarget | undefined;
  pending: boolean;
  error: string | undefined;
  reload(): void;
} {
  const { client } = useLaserStable();
  const setup = useRequest("setup", true, () => client.request("pi/setup/state", {}));
  const projectKnown = scope.projectCwd !== undefined && projects.includes(scope.projectCwd);
  const requested = useMemo<AgentsScopeTarget | undefined>(() => setup.data ? ({
    scope,
    view: scope.view,
    routeCwd: scope.view === "global" ? setup.data.cwd : (projectKnown ? scope.projectCwd! : setup.data.cwd),
    ...(scope.view !== "global" && projectKnown ? { projectCwd: scope.projectCwd } : {}),
  }) : undefined, [projectKnown, scope, setup.data]);
  const key = `${requested?.view ?? "pending"}:${requested?.projectCwd ?? ""}:${requested?.routeCwd ?? "pending"}`;
  const lifetime = useCommittedTargetLifetime(key);
  const [committed, setCommitted] = useState<{
    key: string;
    lease: CommittedTargetLease;
  }>();

  useLayoutEffect(() => {
    if (!requested) return;
    const lease = lifetime.capture();
    if (!lease) return;
    setCommitted({ key, lease });
  }, [key, lifetime, requested]);

  const ready = requested !== undefined
    && committed?.key === key
    && lifetime.isCurrent(committed.lease);
  return {
    target: ready ? requested : undefined,
    pending: setup.loading || (!setup.error && !ready),
    error: setup.error,
    reload: setup.reload,
  };
}
