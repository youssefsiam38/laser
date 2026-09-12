/** Shared by the compact lineage list and canvas, without importing React Flow. */
export function emptyCaption(hidden: number): string {
  if (hidden === 0) return "Agents this session starts will appear here.";
  return hidden === 1 ? "One ended agent is folded away. Show ended brings it back." : `${hidden} ended agents are folded away. Show ended brings them back.`;
}
