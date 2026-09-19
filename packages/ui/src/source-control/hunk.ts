/** Pick the next hunk from separator tops relative to the viewport midpoint. */
export function nextHunkIndex(tops: readonly number[], viewMid: number, delta: number): number | undefined {
  if (!tops.length) return undefined;
  let index = tops.findIndex((top) => top >= viewMid - 1);
  if (index < 0) index = delta > 0 ? 0 : tops.length - 1;
  else if (delta < 0) index = Math.max(0, index - 1);
  else index = Math.min(tops.length - 1, index + 1);
  return index;
}
