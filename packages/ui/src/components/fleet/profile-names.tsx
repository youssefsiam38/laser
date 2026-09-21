"use client";
/**
 * Profile names for the fleet's rows, read once for the column.
 *
 * A run carries the profile it was started on as an opaque id; the name lives
 * in settings. Asking per row would be one request per row, so the column asks
 * once and the rows read it from here. Without a provider the rows show no
 * profile at all rather than an id, which is what a surface that cannot ask
 * (a denied environment, a bare test store) honestly knows.
 */
import { createContext, useContext, type ReactNode } from "react";

import { useProfileNames } from "@/components/assistant-ui/elements/model-profiles";
import { useLaserStable } from "@/runtime";

const EMPTY: ReadonlyMap<string, string> = new Map();
const FleetProfileNames = createContext<ReadonlyMap<string, string>>(EMPTY);

export function FleetProfileNamesProvider({ children }: { children: ReactNode }) {
  const { currentProject } = useLaserStable();
  const names = useProfileNames(currentProject);
  return <FleetProfileNames.Provider value={names}>{children}</FleetProfileNames.Provider>;
}

export function useFleetProfileNames(): ReadonlyMap<string, string> {
  return useContext(FleetProfileNames);
}
