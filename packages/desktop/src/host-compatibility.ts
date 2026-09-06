/** Compare the process record, not files an updater may already have replaced. */
export function hostNeedsRefresh(running: string, bundled: string): boolean {
  return running !== bundled;
}
