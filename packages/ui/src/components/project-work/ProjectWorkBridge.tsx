"use client";
/**
 * The one place the project-work client meets the connection.
 *
 * It binds the registry to this window's `HostClient`, hands it every
 * `project/work/*` notification, catches every project up after a reconnect,
 * throws the whole cache away when the environment changes (ids are stable
 * only inside one host's state root), keeps the saved views in step with the
 * host's preferences, and honours a `#/work/…` link once.
 *
 * It renders nothing. It is mounted once, by the shell.
 */
import { useEffect } from "react";

import { useLaserStable, useLaserState } from "@/runtime";
import {
  bindProjectWork,
  honourWorkLinkFromLocation,
  observeProjectWork,
  reconnectProjectWork,
  resetProjectWork,
} from "@/project-work";
import { resetSavedViews, useSavedViewsSync } from "@/project-work/views";

export function ProjectWorkBridge() {
  const { client } = useLaserStable();
  const connection = useLaserState((state) => state.connection);
  const environmentKey = useLaserState((state) => state.environment?.environmentKey);

  // The registry reads through this window's client, and through no other.
  useEffect(() => {
    const request: Parameters<typeof bindProjectWork>[0] = (method, params) => client.request(method, params);
    bindProjectWork(request);
    return () => bindProjectWork(undefined);
  }, [client]);

  // A different environment is a different host: nothing cached survives it.
  useEffect(() => {
    if (environmentKey === undefined) return;
    return () => {
      resetProjectWork();
      resetSavedViews();
    };
  }, [environmentKey]);

  useEffect(() => {
    const stop = client.subscribe((method, params) => observeProjectWork(method, params));
    return () => stop();
  }, [client]);

  // Reconnect: every project catches up from the sequence it holds. The rows
  // stay on screen while it does.
  useEffect(() => {
    if (connection !== "open") return;
    reconnectProjectWork();
  }, [connection]);

  useSavedViewsSync(client, connection === "open");

  // A link this window was opened with, honoured once the connection is up so
  // the project can actually be read.
  useEffect(() => {
    if (connection !== "open") return;
    honourWorkLinkFromLocation();
  }, [connection]);

  return null;
}
