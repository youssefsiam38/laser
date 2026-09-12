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

/** All catalog writes share an epoch: a late page cannot replace a newer refresh/filter. */
export function createCatalogLoader(deps: CatalogLoaderDeps) {
  let epoch = 0;
  let readers = 0;
  const sizes: Record<string, number> = { ...deps.initialSizes };
  const page = () => ({ size: 7, sizes: { ...sizes }, exclude: deps.exclude(), include: deps.include(), ...(deps.probe ? { probe: deps.probe() } : {}) });
  let included: Set<string> | null = new Set();
  let refreshing: { key: string; epoch: number; promise: Promise<boolean> } | undefined;
  const refresh = (): Promise<boolean> => {
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
  return {
    refresh,
    hasIncluded: (path: string) => included === null || included.has(path),
    async more(cwd: string) {
      const cursor = deps.current().groups?.find(group => group.cwd === cwd)?.cursor;
      if (!cursor) return true;
      const mine = ++epoch;
      const result = await deps.request({ cwd, page: { ...page(), sizes: {}, cursor } });
      if (mine !== epoch) return false;
      sizes[cwd] = (sizes[cwd] ?? 7) + 7;
      const current = deps.current();
      const rows = new Map<string, SessionSummary>(current.sessions.map(row => [row.path, row]));
      for (const row of result.sessions) rows.set(row.path, row);
      const groups = new Map(current.groups?.map(group => [group.cwd, group]));
      for (const group of result.groups ?? []) groups.set(group.cwd, group);
      deps.apply({ ...result, sessions: [...rows.values()], groups: [...groups.values()] });
      return true;
    },
    // Explicit title search / archive disclosure may read all summaries, never bodies.
    expand() { readers++; return () => { readers = Math.max(0, readers - 1); }; },
    async all() { return (await deps.request({})).sessions; },
  };
}
