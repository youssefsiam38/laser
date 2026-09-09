"use client";
/**
 * The fleet, from the app store. One selector, memoized on the inputs the
 * model actually reads, so a streamed token in an unrelated session does not
 * rebuild every group.
 *
 * The fleet is the open session's tree (docs/ux-fleet.md, "One session's
 * tree"): `buildFleet` stays the pure "all work" builder the tests cover, and
 * the scope is applied here. A child session as the open session resolves to
 * its root, so what is shown is the root's tree with the child marked.
 *
 * Elapsed clocks tick here rather than in each row: one interval for the whole
 * column, and only while something *shown* is still going — a fleet that is
 * quiet while another session's agent runs is a still image.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { createAncestryIndex } from "../agents/run-tree.js";
import { useTick } from "../components/thread/timing.js";
import { useLaserStable, useLaserState } from "../runtime/index.js";
import type { AppState } from "../store.js";
import { buildFleet, fleetSummary, scopeFleet, type FleetGroup } from "./model.js";

export interface FleetView {
  /** The session being read, marked in the tree. Undefined when none is open. */
  current: string | undefined;
  /** The top-level session whose tree this is: `current` or its root. */
  root: string | undefined;
  /** The open session's work, nested as it nests. Undefined when it has none. */
  tree: FleetGroup | undefined;
  /** Going and needing a person, in the tree only. */
  running: number;
  needsYou: number;
  /** Work whose root session was deleted, with nowhere else to be seen. */
  elsewhere: FleetGroup[];
  /** The same two counts for `elsewhere`, kept apart so no line adds them up as one session's. */
  elsewhereRunning: number;
  elsewhereNeedsYou: number;
  /** No tree and nothing elsewhere: one of the fleet's two empty states, both real. */
  empty: boolean;
}

export function useFleet(): FleetView {
  const sessions = useLaserState((s: AppState) => s.sessions);
  const sessionsLoaded = useLaserState((s: AppState) => s.sessionsLoaded);
  const runs = useLaserState((s: AppState) => s.agents.runs);
  const tasks = useLaserState((s: AppState) => s.tasks.tasks);
  const views = useLaserState((s: AppState) => s.open);
  const current = useLaserState((s: AppState) => s.current);

  // Elapsed is live only while something shown is. Which items are shown is
  // known only once the fleet is built, so the clock follows the build by one
  // render: `useTick` cannot read a value computed below it.
  const [live, setLive] = useState(false);
  const tick = useTick(live, 1000);

  const fleet = useMemo<FleetView>(() => {
    // The open session's root. An open child knows its root from its own
    // state before the catalog has a row for it; the index answers for the rest.
    const root =
      current === undefined ? undefined : (views[current]?.state.agent?.rootPath ?? createAncestryIndex(runs, sessions).rootOf(current));
    const groups = buildFleet({ sessions, runs, tasks, views, currentPath: current, sessionsLoaded, now: Date.now() });
    const scope = scopeFleet(groups, root);
    const summary = fleetSummary(scope.tree ? [scope.tree] : []);
    const elsewhere = fleetSummary(scope.elsewhere);
    return {
      current,
      root,
      tree: scope.tree,
      running: summary.running,
      needsYou: summary.needsYou,
      elsewhere: scope.elsewhere,
      elsewhereRunning: elsewhere.running,
      elsewhereNeedsYou: elsewhere.needsYou,
      empty: scope.tree === undefined && scope.elsewhere.length === 0,
    };
    // `tick` is the clock: it is in the list on purpose, so elapsed advances
    // without anything else changing.
  }, [sessions, sessionsLoaded, runs, tasks, views, current, tick]);

  const nextLive = fleet.running > 0 || fleet.elsewhereRunning > 0;
  useEffect(() => setLive(nextLive), [nextLive]);

  return fleet;
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
