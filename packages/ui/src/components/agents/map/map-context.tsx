"use client";
/**
 * The two contexts a map node reads.
 *
 * `MapHost` is what the surface around the map can do — open a chat, end an
 * agent, go fullscreen, hold the map in the dock. The connected view wires it
 * to the app's actions; a test wires it to spies. Nodes, rows and the
 * inspector never import the runtime themselves.
 *
 * `MapData` is the drawn tree and the composition, so a React Flow node gets
 * everything it needs from `data.path` alone: the node objects handed to the
 * canvas carry ids and positions only, and re-render on selection and
 * structure — never because a status changed somewhere in the tree.
 */
import { createContext, useContext } from "react";

import type { AgentTree, AgentTreeNode } from "@/agents";

import type { MapComposition } from "./layout.js";

export interface MapHost {
  /** Go to that session's conversation. Also leaves the map. */
  openChat(path: string): void;
  /** Ask to end a running agent (Lane U2's dialog); absent when nothing here can. */
  requestEndAgent?: ((runId: string) => void) | undefined;
  openFullscreen(): void;
  closeFullscreen(): void;
  /** Hold the map in the dock; absent where the dock does not exist. */
  showInDock?: (() => void) | undefined;
  /** The host drawing this map. */
  frame: "column" | "fullscreen" | "dock";
}

const HostContext = createContext<MapHost | null>(null);

export const MapHostProvider = HostContext.Provider;

export function useMapHost(): MapHost {
  const value = useContext(HostContext);
  if (!value) throw new Error("useMapHost must be used inside <MapHostProvider>.");
  return value;
}

export interface MapData {
  rootPath: string;
  tree: AgentTree;
  composition: MapComposition;
  selected: string | undefined;
}

const DataContext = createContext<MapData | null>(null);

export const MapDataProvider = DataContext.Provider;

export function useMapData(): MapData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useMapData must be used inside <MapDataProvider>.");
  return value;
}

/** The tree node for a session path, or `undefined` once it left the tree. */
export function useMapNode(path: string): AgentTreeNode | undefined {
  return useMapData().tree.byPath.get(path);
}
