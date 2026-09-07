import { useEffect, useState } from "react";
import type { ProjectFile, ProjectFiles } from "@lasercode/protocol";
import { useLaserStable } from "@/runtime";

const RESULT_LIMIT = 80;
const EMPTY_FILES: ProjectFile[] = [];

/** Search the full host-side index, not the first page downloaded by the UI. */
export function useProjectFileSearch(cwd: string | undefined, query: string, active = true) {
  const { client } = useLaserStable();
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ cwd: string; query: string; attempt: number; result?: ProjectFiles; failed?: boolean }>();
  useEffect(() => {
    if (!cwd || !active) { setResponse(undefined); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void client.request("pi/project/files", { cwd, query, limit: RESULT_LIMIT }).then(
        (result) => { if (!cancelled) setResponse({ cwd, query, attempt, result }); },
        () => { if (!cancelled) setResponse({ cwd, query, attempt, failed: true }); },
      );
    }, query ? 120 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, cwd, query, attempt, active]);
  const current = response?.cwd === cwd && response?.query === query && response?.attempt === attempt ? response : undefined;
  return {
    files: current?.result?.files ?? EMPTY_FILES,
    loading: active && !!cwd && !current,
    failed: current?.failed ?? false,
    truncated: current?.result?.truncated ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}
