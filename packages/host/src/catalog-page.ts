import { ErrorCodes, ProtocolError, type ClientRequests, type SessionSummary } from "@lasercode/protocol";

type Request = ClientRequests["pi/session/list"]["params"];
type Result = ClientRequests["pi/session/list"]["result"];
const parentOf = (row: SessionSummary) => row.parentPath ?? row.agent?.parentPath;
const order = (a: SessionSummary, b: SessionSummary) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path);
const important = (row: SessionSummary) => row.messageCount === 0 || (row.attention !== undefined && row.attention !== "idle")
  || ["queued", "running", "needs_input"].includes(row.agent?.runStatus ?? "");

/** Read-only projection over the complete decorated catalog. Never reads a body or starts a worker. */
export function pageCatalog(rows: readonly SessionSummary[], request: Request, groupOf: (row: SessionSummary) => string): Result {
  const page = request.page;
  if (!page) return { sessions: [...rows] };
  const excluded = new Set(page.exclude);
  const included = new Set(page.include);
  const byPath = new Map(rows.map(row => [row.path, row]));
  const groups = new Map<string, SessionSummary[]>();
  for (const row of rows) {
    const cwd = groupOf(row);
    const group = groups.get(cwd) ?? [];
    if (!excluded.has(row.path)) group.push(row);
    groups.set(cwd, group);
  }
  let cursor: { cwd: string; at: string; path: string } | undefined;
  if (page.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8"));
      if (!value || typeof value !== "object") throw new Error();
      const item = value as Record<string, unknown>;
      if (typeof item["cwd"] !== "string" || typeof item["at"] !== "string" || typeof item["path"] !== "string"
        || (request.cwd !== undefined && item["cwd"] !== request.cwd)) throw new Error();
      cursor = { cwd: item["cwd"], at: item["at"], path: item["path"] };
    } catch { throw new ProtocolError(ErrorCodes.InvalidParams, "This session page is no longer available. Refresh the list and try again."); }
  }
  const selected = new Set<string>();
  const result: Result = { sessions: [], groups: [], archivedCount: rows.filter(row => excluded.has(row.path)).length,
    presence: Object.fromEntries([...new Set([...(page.include ?? []), ...(page.probe ?? [])])].map(path => [path, byPath.has(path)])),
  };
  for (const [cwd, members] of groups) {
    if ((request.cwd && cwd !== request.cwd) || (cursor && cursor.cwd !== cwd)) continue;
    members.sort(order);
    // Empty/live rows are exceptions, not consumers of the recent-row quota.
    const ordinary = members.filter(row => !important(row));
    const remaining = cursor ? ordinary.filter(row => order(row, { modifiedAt: cursor.at, path: cursor.path } as SessionSummary) > 0) : ordinary;
    const size = page.sizes?.[cwd] ?? page.size ?? 7;
    const batch = remaining.slice(0, size);
    for (const row of members) if (important(row) || included.has(row.path)) selected.add(row.path);
    for (const row of batch) selected.add(row.path);
    const last = batch.at(-1);
    result.groups!.push({ cwd, total: members.length, ...(last && remaining.length > batch.length
      ? { cursor: Buffer.from(JSON.stringify({ cwd, at: last.modifiedAt, path: last.path })).toString("base64url") } : {}) });
  }
  // Explicitly included parents (pinned/open) retain their navigable branch.
  const children = new Map<string, SessionSummary[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent) {
      const siblings = children.get(parent) ?? [];
      siblings.push(row);
      children.set(parent, siblings);
    }
  }
  const pending = [...included].filter(path => selected.has(path));
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const child of children.get(path) ?? []) if (!excluded.has(child.path)) {
      selected.add(child.path); pending.push(child.path);
    }
  }
  // A visible child always carries its actual ancestors, including cross-project parents.
  for (const path of [...selected]) {
    const visited = new Set<string>();
    let row = byPath.get(path);
    while (row && !visited.has(row.path)) {
      visited.add(row.path);
      const parent = parentOf(row);
      row = parent ? byPath.get(parent) : undefined;
      if (row && !excluded.has(row.path)) selected.add(row.path);
    }
  }
  result.sessions = rows.filter(row => selected.has(row.path)).sort(order);
  return result;
}
