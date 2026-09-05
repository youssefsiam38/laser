"use client";
/**
 * Host-owned preferences in the browser (M11-T6).
 *
 * The theme used to live in this tab's `localStorage`, which meant it lived on
 * one device: a phone that paired with a themed desktop opened in the default
 * graphite and stayed there. `pi/prefs/*` moves the same state to the host, so
 * the theme is a property of "your piorbit" rather than of "this browser".
 *
 * `localStorage` is still written, and deliberately: it is what the boot script
 * in `index.html` replays before first paint, so a reload does not flash. The
 * host is the source of truth; the local copy is the cache that makes the first
 * frame right.
 *
 * The loop is closed carefully, because both ends can write:
 *   host → here   `pi/prefs/get` on connect, then `pi/prefs/updated` from any
 *                 device. Applying it must not bounce straight back up.
 *   here → host   the store's own subscription, debounced, because dragging a
 *                 hue slider emits on every frame.
 * Both directions compare the serialised state, so an echo of our own write —
 * or another device saving the theme we already have — settles instead of
 * ping-ponging.
 */
import { useEffect } from "react";

import { DEFAULT_STATE, themeStore, type ThemeState } from "../theme/index.js";
import type { HostClient } from "../client.js";

/** The namespace the theme lives in. Host-owned; not a Pi setting. */
export const THEME_PREFS_NAMESPACE = "theme";

/** How long the last edit sits before it is sent. One save per gesture, not per frame. */
const PUSH_DEBOUNCE_MS = 400;

const serialise = (state: ThemeState): string => JSON.stringify(state);

/**
 * Keep the theme store and the host's `theme` namespace in step for as long as
 * the component is mounted. Safe to call before the socket is open: the first
 * read is retried whenever the connection comes back.
 */
export function useThemeSync(client: HostClient, connected: boolean): void {
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    /** The last state either end is known to agree on. */
    let agreed: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const push = (state: ThemeState): void => {
      const text = serialise(state);
      if (disposed || text === agreed) return;
      agreed = text;
      client.request("pi/prefs/set", { namespace: THEME_PREFS_NAMESPACE, value: JSON.parse(text) as unknown }).catch(() => {
        // A failed save must not leave us believing the host agrees.
        if (agreed === text) agreed = undefined;
      });
    };

    const schedulePush = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        push(themeStore.getState());
      }, PUSH_DEBOUNCE_MS);
    };

    const adopt = (value: unknown): void => {
      const text = JSON.stringify(value);
      // Nothing to do when it is already what this window is wearing; this is
      // the guard that stops an echo turning into a loop.
      if (text === agreed || text === serialise(themeStore.getState())) {
        agreed = text;
        return;
      }
      if (themeStore.hydrate(value)) agreed = text;
    };

    void (async () => {
      try {
        const { entries } = await client.request("pi/prefs/get", { namespace: THEME_PREFS_NAMESPACE });
        if (disposed) return;
        const entry = entries[0];
        if (entry && entry.value !== null && entry.value !== undefined) adopt(entry.value);
        // The host has never been told about a theme, but this browser already
        // has one — the person themed the desktop before there was anywhere to
        // keep it. Hand it up rather than making them choose it again.
        //
        // Two conditions, both about not letting a forgotten tab speak for the
        // person. A window that never had a theme has nothing to say, so it
        // must not seed one (that is how a fresh install ends up with "follow
        // the system" switched off by a browser left open on another port).
        // And a window nobody is looking at is not where the answer lives, so
        // it waits until it is: `visibilitychange` fires the moment it is.
        else seedWhenVisible();
      } catch {
        /* not connected, or an older host: the local theme still applies */
      }
    })();

    /** Hand this window's own theme up, but only once somebody is looking at it. */
    let stopWatchingVisibility: (() => void) | undefined;
    function seedWhenVisible(): void {
      if (disposed || serialise(themeStore.getState()) === serialise(DEFAULT_STATE)) return;
      const doc = globalThis.document as Document | undefined;
      if (!doc || doc.visibilityState === "visible") {
        push(themeStore.getState());
        return;
      }
      const onVisible = (): void => {
        if (doc.visibilityState !== "visible") return;
        stopWatchingVisibility?.();
        seedWhenVisible();
      };
      doc.addEventListener("visibilitychange", onVisible);
      stopWatchingVisibility = () => {
        doc.removeEventListener("visibilitychange", onVisible);
        stopWatchingVisibility = undefined;
      };
    }

    const unsubscribeHost = client.subscribe((method, params) => {
      if (method !== "pi/prefs/updated") return;
      const entry = params as { namespace?: string; value?: unknown };
      if (entry.namespace !== THEME_PREFS_NAMESPACE) return;
      if (entry.value === null || entry.value === undefined) return;
      adopt(entry.value);
    });
    const unsubscribeStore = themeStore.subscribe(schedulePush);

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      stopWatchingVisibility?.();
      unsubscribeHost();
      unsubscribeStore();
    };
  }, [client, connected]);
}
