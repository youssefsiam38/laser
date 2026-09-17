import type { ClientRequests, SessionSummary } from "@lasercode/protocol";

type Params = ClientRequests["pi/session/list"]["params"];
type Result = ClientRequests["pi/session/list"]["result"];
interface CatalogLoaderDeps {
  request(params: Params): Promise<Result>;
  current(): Result;
  apply(result: Result): void;
  exclude(): string[];
  include(): string[];
  probe?(): string[];
  initialSizes?: Record<string, number>;
}

/** Refreshes supersede refreshes; cursor pages are serialized with them so neither can erase the other. */
export function createCatalogLoader(deps: CatalogLoaderDeps) {
  let epoch = 0;
  let readers = 0;
  const sizes: Record<string, number> = { ...deps.initialSizes };
  const page = () => ({ size: 7, sizes: { ...sizes }, exclude: deps.exclude(), include: deps.include(), ...(deps.probe ? { probe: deps.probe() } : {}) });
  let included: Set<string> | null = new Set();
  let refreshing: { key: string; epoch: number; promise: Promise<boolean> } | undefined;
  const loadingMore = new Map<string, Promise<boolean>>();
  let queuedRefresh: Promise<boolean> | undefined;
  const refreshNow = (): Promise<boolean> => {
    const expanded = readers > 0;
    const params = expanded ? {} : { page: page() };
    const key = JSON.stringify(params);
    if (refreshing?.key === key && refreshing.epoch === epoch) return refreshing.promise;
    const mine = ++epoch;
    const request = { key, epoch: mine, promise: Promise.resolve(false) };
    request.promise = deps.request(params).then(result => {
      if (mine !== epoch) return false;
      included = expanded ? null : new Set(params.page?.include);
      deps.apply(expanded ? { ...result, groups: [], archivedCount: result.sessions.filter(row => deps.exclude().includes(row.path)).length } : result);
      return true;
    }).finally(() => { if (refreshing === request) refreshing = undefined; });
    refreshing = request;
    return request.promise;
  };
  const refresh = (): Promise<boolean> => {
    if (!loadingMore.size) return refreshNow();
    if (queuedRefresh) return queuedRefresh;
    const waitThenRefresh = async () => {
      while (loadingMore.size) await Promise.allSettled([...loadingMore.values()]);
      return refreshNow();
    };
    let queued!: Promise<boolean>;
    queued = waitThenRefresh().finally(() => { if (queuedRefresh === queued) queuedRefresh = undefined; });
    queuedRefresh = queued;
    return queued;
  };
  const more = (cwd: string): Promise<boolean> => {
    const pending = loadingMore.get(cwd);
    if (pending) return pending;
    const load = async () => {
      // A refresh already on the wire owns the complete bounded snapshot. Page
      // from the cursor it lands, never from the cursor it is about to replace.
      if (refreshing) await refreshing.promise;
      const cursor = deps.current().groups?.find(group => group.cwd === cwd)?.cursor;
      if (!cursor) return true;
      const before = new Set(deps.current().sessions.map(row => row.path));
      const result = await deps.request({ cwd, page: { ...page(), sizes: {}, cursor } });
      // A caller may replace the catalog while this page is in flight. Apply
      // only to the exact cursor it extended.
      if (deps.current().groups?.find(group => group.cwd === cwd)?.cursor !== cursor) return false;
      sizes[cwd] = (sizes[cwd] ?? 7) + 7;
      const current = deps.current();
      const rows = new Map<string, SessionSummary>(current.sessions.map(row => [row.path, row]));
      for (const row of result.sessions) rows.set(row.path, row);
      const groups = new Map(current.groups?.map(group => [group.cwd, group]));
      for (const group of result.groups ?? []) {
        // An exhausted/stale cursor must still settle the control. A page that
        // added nothing cannot honestly keep offering the same cursor forever.
        if (result.sessions.every(row => before.has(row.path))) {
          const { cursor: _cursor, ...exhausted } = group;
          groups.set(group.cwd, { ...exhausted, remaining: 0 });
        } else groups.set(group.cwd, group);
      }
      deps.apply({ ...result, sessions: [...rows.values()], groups: [...groups.values()] });
      return true;
    };
    let request!: Promise<boolean>;
    request = load().finally(() => { if (loadingMore.get(cwd) === request) loadingMore.delete(cwd); });
    loadingMore.set(cwd, request);
    return request;
  };
  return {
    refresh,
    hasIncluded: (path: string) => included === null || included.has(path),
    more,
    // Explicit title search / archive disclosure may read all summaries, never bodies.
    expand() { readers++; return () => { readers = Math.max(0, readers - 1); }; },
    async all() { return (await deps.request({})).sessions; },
  };
}
