import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientRequests } from "@lasercode/protocol";
import { useLaserStable } from "@/runtime";

type Result = ClientRequests["session/search"]["result"];
const DAYS = [30, 90, 365, Infinity] as const;
const DAY = 86_400_000;
export function searchPeriod(now: number, period: number) {
  const days = DAYS[period] ?? Infinity;
  return {
    after: Number.isFinite(days) ? new Date(now - days * DAY).toISOString() : undefined,
    before: period > 0 ? new Date(now - DAYS[period - 1]! * DAY).toISOString() : undefined,
  };
}
export function periodLabel(now: number, period: number) {
  const { after, before } = searchPeriod(now, period);
  const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (!before) return "Last 30 days";
  return after ? `${date(after)} – ${date(before)}` : `Before ${date(before)}`;
}

/** One query generation; old replies and removed dialogs cannot replace it. */
export function useSessionSearch(query: string, cwd?: string) {
  const { client } = useLaserStable();
  const generation = useRef(0);
  const now = useRef(Date.now());
  const lastRequest = useRef({ period: 0, cursor: undefined as number | undefined, reset: true });
  const [state, setState] = useState<{ key: string; hits: Result["hits"]; period: number; cursor?: number; busy: boolean; error: boolean; unreadable: number }>({ key: "", hits: [], period: 0, busy: false, error: false, unreadable: 0 });
  const key = `${cwd ?? ""}\n${query.trim()}`;
  const request = useCallback(async (period: number, cursor: number | undefined, gen: number, reset: boolean) => {
    lastRequest.current = { period, cursor, reset };
    setState(s => ({ ...s, busy: true, error: false }));
    const range = searchPeriod(now.current, period);
    try {
      const result = await client.request("session/search", { query: query.trim(), ...(cwd ? { cwd } : {}), ...(range.after ? { after: range.after } : {}), ...(range.before ? { before: range.before } : {}), ...(cursor !== undefined ? { cursor } : {}) });
      if (gen !== generation.current) return;
      setState(s => ({ key, hits: [...new Map([...(reset ? [] : s.hits), ...result.hits].map(h => [h.path, h])).values()], period, ...(result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}), busy: false, error: false, unreadable: (reset ? 0 : s.unreadable) + result.unreadable }));
    } catch {
      if (gen === generation.current) setState(s => ({ ...s, busy: false, error: true }));
    }
  }, [client, query, cwd, key]);
  useEffect(() => {
    const gen = ++generation.current;
    now.current = Date.now();
    setState({ key, hits: [], period: 0, busy: Boolean(query.trim()), error: false, unreadable: 0 });
    if (!query.trim()) return;
    const timer = setTimeout(() => void request(0, undefined, gen, true), 220);
    return () => { clearTimeout(timer); generation.current++; };
  }, [key, request]);
  const current = state.key === key ? state : { key, hits: [], period: 0, busy: Boolean(query.trim()), error: false, unreadable: 0 };
  return {
    ...current,
    after: searchPeriod(now.current, current.period).after,
    periodLabel: periodLabel(now.current, current.period),
    moreLabel: current.cursor !== undefined ? "More results from this period" : current.period < 3 ? `Search older · ${periodLabel(now.current, current.period + 1)}` : undefined,
    more: () => { if (!current.busy) void request(current.cursor !== undefined ? current.period : current.period + 1, current.cursor, generation.current, false); },
    retry: () => void request(lastRequest.current.period, lastRequest.current.cursor, generation.current, lastRequest.current.reset),
  };
}
