import { motionMs } from "@/motion";

/** Hold a visible transcript landmark while a batch of disclosures changes. */
export function preserveReadingPosition(viewport: HTMLElement): () => void {
  const top = viewport.getBoundingClientRect().top;
  const messages = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")];
  const message = messages.find(node => node.getBoundingClientRect().bottom > top);
  // Prefer a visible paragraph or row header inside a long message. If that
  // content disappears on collapse, the persistent message is the fallback.
  const landmark = message && [...message.querySelectorAll<HTMLElement>(".md-body > *, [data-slot=collapsible-trigger]")]
    .find(node => node.getBoundingClientRect().top >= top && node.getBoundingClientRect().height > 0);
  const anchors = [landmark, message].filter((node): node is HTMLElement => Boolean(node))
    .map(node => ({ node, offset: node.getBoundingClientRect().top - top }));
  const initialScroll = viewport.scrollTop;
  const previousAnchor = viewport.style.overflowAnchor;
  const previousBehavior = viewport.style.scrollBehavior;
  viewport.style.overflowAnchor = "none";
  viewport.style.scrollBehavior = "auto";
  let frame = 0;
  let stopped = false;
  const restore = () => {
    if (stopped) return;
    const anchor = anchors.find(({ node }) => node.isConnected && node.getBoundingClientRect().height > 0);
    const desired = anchor
      ? viewport.scrollTop + anchor.node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
      : initialScroll;
    const clamped = Math.max(0, Math.min(desired, viewport.scrollHeight - viewport.clientHeight));
    if (Math.abs(viewport.scrollTop - clamped) > 0.5) viewport.scrollTop = clamped;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    viewport.style.overflowAnchor = previousAnchor;
    viewport.style.scrollBehavior = previousBehavior;
    viewport.removeEventListener("scroll", restore);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) viewport.removeEventListener(event, stop);
  };
  const duration = motionMs("--motion-fast");
  // Start after React commits: rendering a long history can itself take longer
  // than the disclosure animation. Starting the clock in the menu click would
  // release the anchor before that animation finishes.
  let until: number | undefined;
  let settledFrames = 0;
  const tick = () => {
    if (!viewport.isConnected) { stop(); return; }
    until ??= performance.now() + duration;
    restore();
    // Include two paints after Radix's closing animation removes its body.
    if (performance.now() >= until && ++settledFrames > 2) { stop(); return; }
    frame = requestAnimationFrame(tick);
  };
  viewport.addEventListener("scroll", restore);
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) viewport.addEventListener(event, stop, { passive: true });
  frame = requestAnimationFrame(tick);
  return stop;
}
