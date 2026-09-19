/** Split view paints each context line twice; keep the first of a duplicate pair. */
export function dedupeDiffLineMatches<T extends { before: string; match: string; after: string }>(
  matches: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const match of matches) {
    const key = `${match.before}\0${match.match}\0${match.after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

export function hiddenMatchCount(modelCount: number, rendered: number): number {
  return Math.max(0, modelCount - rendered);
}

export function overlayFindStatus(query: string, index: number, rendered: number, modelCount: number): string {
  const hidden = hiddenMatchCount(modelCount, rendered);
  if (!query.trim()) return "0 / 0";
  if (rendered) {
    return `${Math.min(index, rendered - 1) + 1} / ${rendered}${hidden ? ` · ${hidden} in collapsed context` : ""}`;
  }
  if (modelCount) return `Collapsed · ${modelCount} in this file`;
  return "No matches";
}
