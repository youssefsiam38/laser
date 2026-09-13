import { useEffect, useState } from "react";
import type { DirectoryEntry, DirectoryListing } from "@lasercode/protocol";
import { useLaserStable } from "@/runtime";
import { resolveProjectPath } from "./project-path.js";

const EMPTY: DirectoryEntry[] = [];
const PAGE_SIZE = 80;

/** A bounded host page, keyed by directory AND prefix. Never show a stale path. */
export function useProjectFileSearch(cwd: string | undefined, query: string, active = true) {
  const { client } = useLaserStable();
  const resolution = resolveProjectPath(query, cwd ?? "");
  const key = JSON.stringify([cwd, query]);
  const [page, setPage] = useState({ key, offset: 0 });
  if (page.key !== key) setPage({ key, offset: 0 });
  const offset = page.key === key ? page.offset : 0;
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; offset: number; attempt: number; result?: DirectoryListing; failed?: boolean }>();
  useEffect(() => {
    if (!cwd || !active || resolution.error) { setResponse(undefined); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void client.request("pi/project/browse", { path: resolution.directory!, explorer: { mode: "explorer", root: cwd, prefix: resolution.prefix!, offset, limit: PAGE_SIZE } }).then(
        (result) => { if (!cancelled) setResponse({ key, offset, attempt, result }); },
        () => { if (!cancelled) setResponse({ key, offset, attempt, failed: true }); },
      );
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, cwd, key, offset, attempt, active, resolution.directory, resolution.prefix, resolution.error]);
  const current = response?.key === key && response.offset === offset && response.attempt === attempt ? response : undefined;
  const error = resolution.error ?? current?.result?.error ?? (current?.failed ? "Couldn’t read this folder. Try again." : undefined);
  return {
    query,
    files: current?.result?.entries ?? EMPTY,
    loading: active && !!cwd && !error && !current,
    failed: !!error,
    error,
    head: resolution.head ?? "",
    directory: cwd ? resolution.directory : undefined,
    commonPrefix: current?.result?.commonPrefix ?? "",
    truncated: current?.result?.truncated ?? false,
    offset,
    next: current?.result?.nextOffset === undefined ? undefined : () => setPage({ key, offset: current.result!.nextOffset! }),
    previous: offset ? () => setPage({ key, offset: Math.max(0, offset - PAGE_SIZE) }) : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
