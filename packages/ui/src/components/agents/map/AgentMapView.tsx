"use client";
/**
 * The map, connected (docs/agents.md §5). Resolves which tree the open
 * session belongs to, asks the host for that tree's runs once, and wires the
 * map's host verbs to the app's actions:
 *
 *   - "Chat" opens the session and leaves the map (the column shows the
 *     thread again, the fullscreen host closes);
 *   - "End agent…" asks the shell's `EndAgentDialog` through `requestEndAgent`;
 *   - "Show in dock" holds the map as a dock island and returns to the thread.
 *
 * The loading and error states are drawn here too, so the map itself only ever
 * receives a tree.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentTree, useLatestRun, useSessionAgent } from "@/agents";
// Ending a run goes through the shell's one dialog (Lane U2, `components/agents`).
import { requestEndAgent } from "@/components/agents";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { useShellOptional } from "@/components/shell/shell-context";
import { useLaserStable, useLaserState, useLaserView } from "@/runtime";

import { AgentMap } from "./AgentMap.js";
import { MapHostProvider, type MapHost } from "./map-context.js";
import { mapUi } from "./map-state.js";

/** The top-level session `path` belongs to: its own attribution, its run's root, or itself. */
export function useMapRoot(path: string | undefined): string | undefined {
  const info = useSessionAgent(path);
  const run = useLatestRun(path);
  if (path === undefined) return undefined;
  return info?.rootPath ?? run?.rootSessionPath ?? path;
}

/** Trees whose runs this client has already asked for; a host switch must not ask again. */
const requested = new Set<string>();

export interface AgentMapConnectedProps {
  rootPath: string;
  frame: MapHost["frame"];
  focusPath?: string | undefined;
  chrome?: boolean;
}

export function AgentMapConnected({ rootPath, frame, focusPath, chrome = true }: AgentMapConnectedProps) {
  const tree = useAgentTree(rootPath);
  const error = useLaserState((s) => s.agents.error);
  const { actions } = useLaserStable();
  const shell = useShellOptional();
  const [pending, setPending] = useState(() => !requested.has(rootPath));

  const load = useCallback(() => {
    setPending(true);
    void actions.agents.runs(rootPath).finally(() => setPending(false));
  }, [actions, rootPath]);
  useEffect(() => {
    if (requested.has(rootPath)) {
      setPending(false);
      return;
    }
    requested.add(rootPath);
    load();
  }, [rootPath, load]);

  const host = useMemo<MapHost>(
    () => ({
      frame,
      openChat: (path) => {
        mapUi.setFullscreen(false);
        mapUi.setOpen(false);
        void actions.openSession(path);
      },
      requestEndAgent,
      openFullscreen: () => mapUi.setFullscreen(true),
      closeFullscreen: () => mapUi.setFullscreen(false),
    }),
    [actions, frame, rootPath],
  );

  if (!tree) return null;
  if (pending && tree.nodes.length === 1) {
    return (
      <div data-slot="agent-map-loading" className="flex h-full min-h-0 w-full items-center justify-center bg-bg p-6">
        <GenerationLoader label="Finding this session’s agents" />
      </div>
    );
  }
  const notice = error ? (
    <div className="px-3 pt-3">
      <ErrorState title="The map may be behind" detail={error} onRetry={load} retryLabel="Try again" />
    </div>
  ) : undefined;
  return (
    <MapHostProvider value={host}>
      <AgentMap rootPath={rootPath} tree={tree} focusPath={focusPath} chrome={chrome} notice={notice} />
    </MapHostProvider>
  );
}

/** The main column's map, for the open session's tree. Nothing when nothing is open. */
export function AgentMapView() {
  const view = useLaserView();
  const rootPath = useMapRoot(view?.path);
  if (!view || !rootPath) return null;
  return <AgentMapConnected rootPath={rootPath} frame="column" focusPath={view.path} />;
}
