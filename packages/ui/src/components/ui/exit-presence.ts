"use client";
/**
 * A closing overlay always leaves the document.
 *
 * Radix `Presence` keeps a closing element mounted (`unmountSuspended`) until
 * an `animationend` or `animationcancel` arrives on it, and it decides to wait
 * from the computed `animation-name` alone. The two do not always agree: a
 * zero-duration animation still computes `animation-name: exit` while the
 * engine creates no animation for it at all — no `animationstart`, no
 * `animationend`, `el.getAnimations()` empty — so the closed dialog stays in
 * the document, painted over the page, with its buttons still clickable.
 *
 * The root of that is the token, and it is fixed there: with Motion reduced
 * the enter/exit utilities carry no animation at all (`--motion-off` in
 * `globals.css`, written by `theme/compile.ts`), so `Presence` unmounts
 * immediately instead of waiting for nothing. This hook is the floor under
 * that fix, for every other way an exit can fail to end: a stylesheet that
 * promises an animation the engine never starts, an animation removed or
 * finished while the page was hidden, an event the browser drops.
 *
 * It never shortens a real exit. While the browser reports a live animation
 * on the element it does nothing and the fade plays to its end; only when the
 * element is closed, still in the document, and nothing is actually animating
 * does it tell `Presence` what it is waiting for.
 *
 * Attach it to any Radix content or overlay that carries `data-state`:
 *
 * ```tsx
 * function DialogContent({ ref, ...props }) {
 *   return <DialogPrimitive.Content ref={useExitPresence(ref)} {...props} />;
 * }
 * ```
 */
import { useCallback } from "react";
import type * as React from "react";

/** Room for the frame an exit is scheduled on, on top of its own duration. */
export const EXIT_SLACK_MS = 60;
/** Used when the element promises an exit but declares no time for it. */
export const EXIT_FALLBACK_MS = 160;

/** One CSS `<time>` in milliseconds; 0 for anything unreadable. */
function timeMs(raw: string): number {
  const value = raw.trim();
  const ms = value.endsWith("ms")
    ? Number.parseFloat(value)
    : value.endsWith("s")
      ? Number.parseFloat(value) * 1000
      : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * The longest `delay + duration` in a computed animation shorthand, in ms —
 * how long the element may legitimately take to leave. Both lists repeat to
 * the length of the name list, which is what the cycling here stands in for.
 */
export function exitWindowMs(duration: string | undefined, delay: string | undefined): number {
  const list = (raw: string | undefined): number[] => {
    const parts = (raw ?? "").split(",").map(timeMs);
    return parts.length > 0 ? parts : [0];
  };
  const durations = list(duration);
  const delays = list(delay);
  const count = Math.max(durations.length, delays.length);
  let longest = 0;
  for (let i = 0; i < count; i += 1) {
    longest = Math.max(longest, (durations[i % durations.length] ?? 0) + (delays[i % delays.length] ?? 0));
  }
  return longest;
}

/** Is the browser actually running (or holding) an animation on this node? */
function liveAnimations(node: Element): boolean | undefined {
  const get = (node as Element & { getAnimations?: () => Animation[] }).getAnimations;
  if (typeof get !== "function") return undefined; // no WAAPI: fall back to the declared window
  return get.call(node).some((animation) => animation.playState === "running" || animation.playState === "paused");
}

/**
 * Tell `Presence` the exit it is waiting for is over. It listens on the node
 * itself and matches `event.animationName` against the computed name, so each
 * name in the list gets its own event.
 */
function endExit(node: HTMLElement, names: string): void {
  for (const name of names.split(",").map((n) => n.trim()).filter((n) => n && n !== "none")) {
    let event: Event;
    try {
      event = new AnimationEvent("animationend", { animationName: name, bubbles: false });
    } catch {
      // Older or headless DOMs without the constructor.
      event = new Event("animationend");
      Object.defineProperty(event, "animationName", { value: name });
    }
    node.dispatchEvent(event);
  }
}

function assign<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.RefObject<T | null>).current = value;
}

/**
 * A ref for a Radix content/overlay element that guarantees its unmount.
 * Pass the caller's own ref through it; it is composed, not replaced.
 */
export function useExitPresence<T extends HTMLElement>(forwarded?: React.Ref<T> | undefined): React.RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      assign(forwarded, node);
      if (!node || typeof MutationObserver === "undefined" || typeof getComputedStyle !== "function") {
        return () => assign(forwarded, null);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline = 0;
      const clear = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      const rearm = (delay: number): void => {
        clear();
        timer = setTimeout(check, Math.max(delay, 0));
      };

      function check(): void {
        timer = undefined;
        if (!node || !node.isConnected) return;
        if (node.getAttribute("data-state") !== "closed") return; // open again: not ours
        const styles = getComputedStyle(node);
        const names = styles.animationName;
        if (!names || names === "none") return; // Presence unmounts this one by itself
        const live = liveAnimations(node);
        if (live === true) {
          rearm(EXIT_SLACK_MS); // a real exit is playing; let it finish
          return;
        }
        if (live === undefined && Date.now() < deadline) {
          rearm(deadline - Date.now()); // no WAAPI to ask: trust the declared time
          return;
        }
        endExit(node, names);
      }

      const closing = (): void => {
        const styles = getComputedStyle(node);
        // An unreadable duration is not a zero one: a DOM that reports no
        // time at all gets the fallback window, a stylesheet that really
        // says `0s` gets the frame it takes to find that out.
        const declared = styles.animationDuration?.trim()
          ? exitWindowMs(styles.animationDuration, styles.animationDelay)
          : EXIT_FALLBACK_MS;
        deadline = Date.now() + declared + EXIT_SLACK_MS;
        rearm(0);
      };

      const observer = new MutationObserver(() => {
        if (node.getAttribute("data-state") === "closed") closing();
        else clear();
      });
      observer.observe(node, { attributes: true, attributeFilter: ["data-state"] });
      if (node.getAttribute("data-state") === "closed") closing();

      return () => {
        observer.disconnect();
        clear();
        assign(forwarded, null);
      };
    },
    [forwarded],
  );
}
