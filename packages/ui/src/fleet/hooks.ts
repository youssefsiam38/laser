"use client";
/**
 * The fleet, from the app store. One selector, memoized on the four inputs the
 * model actually reads, so a streamed token in an unrelated session does not
 * rebuild every group.
 *
 * Elapsed clocks tick here rather than in each row: one interval for the whole
 * column, and only while something is still going.
 */
import { useEffect, useMemo, useRef } from "react";

import { useTick } from "../components/thread/timing.js";
import { useLaserStable, useLaserState } from "../runtime/index.js";
import type { AppState } from "../store.js";
import { buildFleet, fleetSummary, type FleetGroup } from "./model.js";

export interface FleetView {
  groups: FleetGroup[];
  running: number;
  needsYou: number;
  /** Nothing anywhere: the fleet's empty state, which is a real state. */
  empty: boolean;
}

export function useFleet(): FleetView {
  const sessions = useLaserState((s: AppState) => s.sessions);
  const runs = useLaserState((s: AppState) => s.agents.runs);
  const tasks = useLaserState((s: AppState) => s.tasks.tasks);
  const views = useLaserState((s: AppState) => s.open);
  const current = useLaserState((s: AppState) => s.current);

  // Elapsed is live only while something is: a fleet of finished work is a
  // still image, and a still image must not re-render every second.
  const live = useMemo(
    () =>
      Object.values(runs).some((run) => run.status === "running" || run.status === "queued") ||
      Object.values(tasks).some((task) => task.status === "running"),
    [runs, tasks],
  );
  const tick = useTick(live, 1000);

  return useMemo(() => {
    const groups = buildFleet({ sessions, runs, tasks, views, currentPath: current, now: Date.now() });
    const summary = fleetSummary(groups);
    return { groups, running: summary.running, needsYou: summary.needsYou, empty: groups.length === 0 };
    // `tick` is the clock: it is in the list on purpose, so elapsed advances
    // without anything else changing.
  }, [sessions, runs, tasks, views, current, tick]);
}

/**
 * Prime the fleet from the host, and prime it again after a reconnect.
 *
 * Notifications are not replayed, so a client that reloads — or a laptop that
 * slept through a run finishing — would otherwise show a column that is
 * quietly wrong. Both lists are one request each and the host answers from
 * memory, so this is cheap enough to do on every open. Mounted once, by the
 * shell.
 */
export function useFleetReconcile(): void {
  const { actions } = useLaserStable();
  const connection = useLaserState((s: AppState) => s.connection);
  const primed = useRef(false);
  useEffect(() => {
    if (connection !== "open") {
      primed.current = false;
      return;
    }
    if (primed.current) return;
    primed.current = true;
    void actions.agents.runs();
    void actions.tasks.list();
  }, [actions, connection]);
}
