import { useEffect, useRef } from "react";

import { useLaserStable, useLaserState } from "@/runtime";
import type { AppState } from "@/store";

import { getChangesAdapterSource, resetChangesAdapter, setChangesAdapter } from "./data.js";
import { createHostChangesAdapter, resolveChangesSession } from "./host-adapter.js";
import { peekChangesUi, useChangesUi } from "./store.js";

/** Register the protocol adapter for as long as the overlay host is mounted. */
export function useBindHostChangesAdapter(): void {
  const { client } = useLaserStable();
  const app = useLaserState((state: AppState) => state);
  const sessionKey = useChangesUi().sessionKey;
  const live = useRef({ app, sessionKey });
  live.current = { app, sessionKey };

  useEffect(() => {
    setChangesAdapter(
      createHostChangesAdapter({
        request: (method, params) => client.request(method, params),
        session: () => resolveChangesSession(live.current.app, live.current.sessionKey),
        agentRun: (runId) => live.current.app.agents.runs[runId],
        scope: () => peekChangesUi().scope,
      }),
      "host",
    );
    return () => {
      if (getChangesAdapterSource() === "host") resetChangesAdapter();
    };
  }, [client]);
}
