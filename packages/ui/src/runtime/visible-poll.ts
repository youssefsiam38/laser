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

/** Run `catchUp` each time the document becomes visible again. Returns a stop function.
 * For state a hidden window may hold stale: a hidden page's timers are throttled to a
 * second, and to a minute once it has been hidden for five (Chromium's intensive
 * wake-up throttling), so the first paint after returning must not wait for a timer.
 * The desktop window is hidden, not closed, whenever a person puts the app away.
 */
export function onVisible(catchUp: () => void, doc: Document = document): () => void {
  const handler = () => { if (doc.visibilityState === "visible") catchUp(); };
  doc.addEventListener("visibilitychange", handler);
  return () => doc.removeEventListener("visibilitychange", handler);
}
