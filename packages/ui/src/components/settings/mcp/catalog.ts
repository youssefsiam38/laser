import type { McpServerStatus, McpToolCatalogState } from "@lasercode/protocol";
import { useEffect, useState } from "react";
import { statusWords, type StatusWords } from "./model.js";

export function toolCatalogFresh(catalog: McpToolCatalogState | undefined, now = Date.now()): boolean {
  return catalog !== undefined && catalog.expiresAt > now;
}

export function catalogStatusWords(status: McpServerStatus, catalog: McpToolCatalogState | undefined, hasCounts: boolean, now = Date.now()): StatusWords {
  if ((status === "ready" && !toolCatalogFresh(catalog, now)) || (status === "unknown" && hasCounts)) {
    return { label: "Needs refresh", tone: "muted", help: "Tool information is out of date. Open the server to check it again." };
  }
  return statusWords(status);
}

/** One local repaint at expiry, never a polling request or a background refresh. */
export function useCatalogClock(expiresAt: number | undefined): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiresAt, tick]);
  return Date.now();
}
