/** Nonessential presentation polling only. Transport, agent execution, questions,
 * notifications and seen acknowledgements do not pass through this scheduler.
 * The caller owns its initial/reconnect refresh; returning to view reconciles now.
 */
export function startVisiblePoll(refresh: () => void, intervalMs: number, doc: Document = document): () => void {
  let visible = doc.visibilityState === "visible";
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearInterval(timer); timer = undefined; };
  const start = () => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      // A hidden transition can precede delivery of visibilitychange.
      if (doc.visibilityState === "visible") refresh();
    }, intervalMs);
  };
  const reconcile = () => {
    const next = doc.visibilityState === "visible";
    if (next === visible) return;
    visible = next;
    stop();
    if (visible) { refresh(); start(); }
  };
  if (visible) start();
  doc.addEventListener("visibilitychange", reconcile);
  return () => { stop(); doc.removeEventListener("visibilitychange", reconcile); };
}
