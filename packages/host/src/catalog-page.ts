import { ErrorCodes, ProtocolError, type ClientRequests, type SessionSummary } from "@lasercode/protocol";

type Request = ClientRequests["pi/session/list"]["params"];
type Result = ClientRequests["pi/session/list"]["result"];
const parentOf = (row: SessionSummary) => row.parentPath ?? row.agent?.parentPath;
const order = (a: SessionSummary, b: SessionSummary) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path);
/**
 * Rows a page must carry whatever its quota: an empty conversation, one that
 * needs a person now, one that is live. A finished child nobody has opened is
 * not one of them: `finished_unread` stays on every subagent row for ever
 * (a person rarely opens a child), and exempting those pulled hundreds of
 * rows and their ancestors into every refresh, defeating paging altogether.
 * A child rides in with its root when the root is paged; a root's own
 * `finished_unread` still pins it, since that is the notice a person reads.
 */
const important = (row: SessionSummary) => row.messageCount === 0
  || (row.attention !== undefined && row.attention !== "idle" && !(row.attention === "finished_unread" && parentOf(row) !== undefined))
  || ["queued", "running", "needs_input"].includes(row.agent?.runStatus ?? "");

function addDescendants(
  selected: Set<string>,
  seeds: Iterable<string>,
  children: ReadonlyMap<string, readonly SessionSummary[]>,
  excluded: ReadonlySet<string>,
  allowed?: ReadonlySet<string>,
): void {
  const pending = [...seeds].filter(path => selected.has(path));
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const child of children.get(path) ?? []) {
      if (excluded.has(child.path) || (allowed && !allowed.has(child.path))) continue;
      selected.add(child.path);
      pending.push(child.path);
    }
  }
}

function addAncestors(selected: Set<string>, byPath: ReadonlyMap<string, SessionSummary>, excluded: ReadonlySet<string>): void {
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
}

/** Read-only projection over the complete decorated catalog. Never reads a body or starts a worker. */
export function pageCatalog(rows: readonly SessionSummary[], request: Request, groupOf: (row: SessionSummary) => string): Result {
  const page = request.page;
  if (!page) return { sessions: [...rows] };
  const excluded = new Set(page.exclude);
  const included = new Set(page.include);
  const byPath = new Map(rows.map(row => [row.path, row]));
  const groups = new Map<string, SessionSummary[]>();
  const children = new Map<string, SessionSummary[]>();
  for (const row of rows) {
    const cwd = groupOf(row);
    const group = groups.get(cwd) ?? [];
    if (!excluded.has(row.path)) group.push(row);
    groups.set(cwd, group);
    const parent = parentOf(row);
    if (parent) {
      const siblings = children.get(parent) ?? [];
      siblings.push(row);
      children.set(parent, siblings);
    }
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

  // Quota exemption is global so an included/live branch never consumes a
  // later page. Selection is deliberately separate and group-scoped below.
  const quotaExempt = new Set(rows.filter(row => !excluded.has(row.path) && (important(row) || included.has(row.path))).map(row => row.path));
  addDescendants(quotaExempt, included, children, excluded);
  addAncestors(quotaExempt, byPath, excluded);

  const selected = new Set<string>();
  const selectionScope = new Set<string>();
  const result: Result = { sessions: [], groups: [], archivedCount: rows.filter(row => excluded.has(row.path)).length,
    presence: Object.fromEntries([...new Set([...(page.include ?? []), ...(page.probe ?? [])])].map(path => [path, byPath.has(path)])),
  };
  for (const [cwd, members] of groups) {
    if ((request.cwd && cwd !== request.cwd) || (cursor && cursor.cwd !== cwd)) continue;
    members.sort(order);
    const memberPaths = new Set(members.map(row => row.path));
    for (const path of memberPaths) selectionScope.add(path);
    const roots = members.filter(row => {
      const parent = parentOf(row);
      return parent === undefined || !memberPaths.has(parent);
    });
    // The list batches roots. Descendants arrive with their root but do not
    // turn “Load 7 more” into three collapsed rows and four hidden children.
    const ordinaryRoots = roots.filter(row => !quotaExempt.has(row.path));
    const remaining = cursor ? ordinaryRoots.filter(row => order(row, { modifiedAt: cursor.at, path: cursor.path } as SessionSummary) > 0) : ordinaryRoots;
    const size = page.sizes?.[cwd] ?? page.size ?? 7;
    const batch = remaining.slice(0, size);
    for (const row of members) if (quotaExempt.has(row.path)) selected.add(row.path);
    for (const row of batch) selected.add(row.path);
    addDescendants(selected, batch.map(row => row.path), children, excluded, memberPaths);
    const last = batch.at(-1);
    const left = remaining.length - batch.length;
    result.groups!.push({ cwd, total: members.length, remaining: left, ...(last && left > 0
      ? { cursor: Buffer.from(JSON.stringify({ cwd, at: last.modifiedAt, path: last.path })).toString("base64url") } : {}) });
  }
  // Explicit includes retain their navigable branch; every selected child
  // carries the ancestors needed to place it, even across a project boundary.
  addDescendants(selected, included, children, excluded, selectionScope);
  addAncestors(selected, byPath, excluded);
  result.sessions = rows.filter(row => selected.has(row.path)).sort(order);
  return result;
}
