"use client";
/**
 * Profile names for the fleet's rows, read once for the column.
 *
 * A run carries the profile it was started on as an opaque id; the name lives
 * in settings. Asking per row would be one request per row, so the column asks
 * once through the shared provider and the rows read it from there.
 */
import type { ReactNode } from "react";

import { ProfileNamesProvider, useProfileNamesMap } from "@/components/assistant-ui/elements/model-profiles";
import { useLaserStable } from "@/runtime";

export function FleetProfileNamesProvider({ children }: { children: ReactNode }) {
  const { currentProject } = useLaserStable();
  return <ProfileNamesProvider cwd={currentProject}>{children}</ProfileNamesProvider>;
}

export const useFleetProfileNames = useProfileNamesMap;
