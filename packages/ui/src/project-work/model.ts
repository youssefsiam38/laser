/**
 * Pure helpers over one project's work, shared by the store and every surface.
 *
 * Nothing here reads the network or the DOM: the store owns the cache, the
 * host owns the truth, and this file only says what a row *means*.
 */
import {
  type ProjectWorkAttentionItem,
  type ProjectWorkAttentionReason,
  type ProjectWorkKind,
  type ProjectWorkListItem,
} from "@lasercode/protocol";

/**
 * Why this row is waiting on a person.
 *
 * The same rule the host applies when it builds `project/work/attention`
 * (`host/src/project-work/store.ts`, `attention`), derived from the row so the
 * queue is exact from the first list rather than only after a notification
 * happens to arrive. Blocking comments win, then a stale input, then the
 * review gate, then a blocked task.
 */
export function attentionReasonOf(item: ProjectWorkListItem): ProjectWorkAttentionReason | undefined {
  if (!item.needsAttention) return undefined;
  if (item.blockingComments > 0) return "blocking_comment";
  if (item.state === "stale" || item.staleBecauseKey !== undefined) return "stale";
  if (item.state === "needs_review") return "gate";
  if (item.state === "blocked") return "blocked_task";
  return "gate";
}

/** The queue, derived from the cache: everything waiting, newest first. */
export function attentionQueue(items: readonly ProjectWorkListItem[]): ProjectWorkAttentionItem[] {
  return items
    .filter((item) => item.needsAttention && !item.archived)
    .map((item) => ({
      entityId: item.ref.entityId,
      kind: item.kind,
      key: item.key,
      title: item.title,
      reason: attentionReasonOf(item) ?? "gate",
      at: item.updatedAt,
    }))
    .sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at < b.at ? 1 : -1));
}

/**
 * Newest first, then by key, so two rows written in the same millisecond keep
 * a stable order instead of swapping on every render.
 */
export function byRecency(a: ProjectWorkListItem, b: ProjectWorkListItem): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return compareKeys(b.key, a.key);
}

/** `SPEC-2` before `SPEC-12`: the number is a number, not a string. */
export function compareKeys(a: string, b: string): number {
  const split = (key: string): [string, number] => {
    const dash = key.lastIndexOf("-");
    const prefix = dash === -1 ? key : key.slice(0, dash);
    const number = dash === -1 ? 0 : Number.parseInt(key.slice(dash + 1), 10);
    return [prefix, Number.isFinite(number) ? number : 0];
  };
  const [prefixA, numberA] = split(a);
  const [prefixB, numberB] = split(b);
  return prefixA === prefixB ? numberA - numberB : prefixA.localeCompare(prefixB);
}

/** Every kind that has at least one item, in the domain's own order. */
export function kindsPresent(items: readonly ProjectWorkListItem[]): ProjectWorkKind[] {
  const seen = new Set<ProjectWorkKind>(items.map((item) => item.kind));
  return (["spec", "research", "design", "plan", "task"] as const).filter((kind) => seen.has(kind));
}
