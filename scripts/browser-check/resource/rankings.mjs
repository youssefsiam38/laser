/**
 * Every owner row enters the report through here, already sanitized, so the
 * JSON and the Markdown carry the same safe label and no renderer can
 * reintroduce a path or a transcript name later.
 */
import { sanitizeOwner } from './report.mjs';

export function addOwner(rankings, category, owner, bytes) {
  const rows = (rankings[category] ??= []);
  rows.push({ owner: sanitizeOwner(owner), bytes: Number(bytes) || 0 });
  return rows;
}

/** Retained-heap owners for one capture, plus its largest owned nodes. */
export function addHeapOwners(rankings, category, phaseName, result, { prefix = '' } = {}) {
  for (const [target, item] of Object.entries(result?.targets ?? {})) {
    if (!item.available) continue;
    addOwner(rankings, category, `${phaseName}/${prefix}${target}`, item.retainedBytes);
    for (const child of item.largestOwnedNodes ?? []) addOwner(rankings, `${category}-nodes`, `${child.type}/${child.name}`, child.bytes);
  }
}

export function addRendererProjection(rankings, rows = []) {
  for (const row of rows) addOwner(rankings, 'renderer-state-projection', `renderer/state.open/${row.owner}/entries`, row.bytes);
}

export function setCategory(rankings, category, rows = []) {
  rankings[category] = rows.map(row => ({ owner: sanitizeOwner(row.owner), bytes: Number(row.bytes) || 0 }));
  return rankings[category];
}
