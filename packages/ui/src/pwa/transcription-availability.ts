import { useEffect, useState } from "react";
import { extendedRequest, type RawRequestClient } from "./host-rpc.js";

// A host connection owns its answers: never reuse another host's credentials.
const caches = new WeakMap<RawRequestClient, Map<string, { until: number; result: Promise<boolean> }>>();
const freshness = 30_000;

export function transcriptionAvailable(client: RawRequestClient, cwd: string): Promise<boolean> {
  let cache = caches.get(client);
  if (!cache) caches.set(client, cache = new Map());
  const previous = cache.get(cwd);
  if (previous && previous.until > Date.now()) return previous.result;
  const result = extendedRequest(client, "pi/transcribe/status", { cwd }).then(status => status.available).catch(() => {
    if (cache.get(cwd)?.result === result) cache.delete(cwd);
    return false; // Capability discovery is quiet; it never opens the microphone.
  });
  cache.set(cwd, { until: Date.now() + freshness, result });
  return result;
}

export function useTranscriptionAvailable(client: RawRequestClient, cwd: string | undefined): boolean {
  const [answer, setAnswer] = useState<{ client: RawRequestClient; cwd: string; available: boolean }>();
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const refresh = () => {
      void transcriptionAvailable(client, cwd).then(available => {
        if (!cancelled) setAnswer({ client, cwd, available });
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.removeEventListener("focus", refresh); };
  }, [client, cwd]);
  return answer?.client === client && answer.cwd === cwd && answer.available;
}
