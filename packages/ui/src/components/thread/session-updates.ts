/**
 * Subscribe to one session's `session/update` stream straight from the
 * `HostClient`, for state the reducer does not keep (turn timing, tokens,
 * "did this turn touch files"). Listeners are called in arrival order, after
 * the store has folded the same update.
 */
import type { SessionUpdateParams } from "@lasercode/protocol";
import { useEffect, useRef } from "react";

import { useLaserStable } from "@/runtime";

export function useSessionUpdates(path: string | undefined, onUpdate: (params: SessionUpdateParams) => void): void {
  const { client } = useLaserStable();
  const handler = useRef(onUpdate);
  handler.current = onUpdate;
  useEffect(() => {
    if (!path) return;
    return client.subscribe((method, params) => {
      if (method !== "session/update") return;
      const p = params as SessionUpdateParams;
      if (p.sessionPath === path) handler.current(p);
    });
  }, [client, path]);
}
