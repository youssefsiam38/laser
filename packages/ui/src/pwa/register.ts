import { SW_SKIP_WAITING, SW_PUSH_CHANGED } from "@lasercode/protocol";
/**
 * Service worker registration and the "a new version is ready" moment.
 *
 * A tiny external store the React side subscribes to. Registration is a
 * production-only, secure-context-only act; everywhere else the store simply
 * reports why there is no worker, and the UI says so where it matters
 * (`InsecureOriginNotice`).
 */
import { useSyncExternalStore } from "react";

export interface ServiceWorkerSnapshot {
  /** `navigator.serviceWorker` exists and the origin is secure. */
  supported: boolean;
  /** Why registration did not happen, in words. Absent when it did (or is in flight). */
  unavailable?: string;
  registered: boolean;
  /** A newer worker is installed and waiting; `applyUpdate()` swaps and reloads. */
  updateReady: boolean;
  /** Registration or update threw; the app still works, only offline caching is off. */
  error?: string;
}

let snapshot: ServiceWorkerSnapshot = { supported: false, registered: false, updateReady: false };
let registration: ServiceWorkerRegistration | undefined;
let waiting: ServiceWorker | undefined;
const listeners = new Set<() => void>();
const messageListeners = new Set<(data: unknown) => void>();

function publish(next: Partial<ServiceWorkerSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}

export function getServiceWorkerRegistration(): ServiceWorkerRegistration | undefined {
  return registration;
}

/** Messages the worker posts to pages (`laser:navigate`, `laser:push-changed`). */
export function onServiceWorkerMessage(listener: (data: unknown) => void): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

/**
 * Register `/sw.js`. Idempotent. Resolves when the browser has a registration
 * (not when the worker is active). Never throws: failure is state, not an
 * exception, because the page must render either way.
 */
export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) {
    publish({ supported: false, unavailable: "This browser has no service worker support, so the app cannot be saved for offline use." });
    return;
  }
  if (!window.isSecureContext) {
    publish({
      supported: false,
      unavailable: "Offline use, installing and notifications need a secure address (https). This page was opened over plain http.",
    });
    return;
  }
  if (registration) return;
  publish({ supported: true });
  try {
    navigator.serviceWorker.addEventListener("message", (event) => {
      for (const l of messageListeners) l(event.data);
    });
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    publish({ registered: true });
    watchForUpdates(registration);
    // A phone that comes back after days should learn about a new build without
    // needing a cold start.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => {});
    });
  } catch (error) {
    publish({ error: error instanceof Error ? error.message : String(error) });
  }
}

function watchForUpdates(reg: ServiceWorkerRegistration): void {
  const noteWaiting = (worker: ServiceWorker | null) => {
    // No controller means this is the first install: nothing to swap, no prompt.
    if (!worker || !navigator.serviceWorker.controller) return;
    waiting = worker;
    publish({ updateReady: true });
  };
  noteWaiting(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") noteWaiting(installing);
    });
  });
}

/** Swap to the waiting worker and reload once it controls the page. */
export function applyUpdate(): void {
  if (!waiting) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waiting.postMessage({ type: SW_SKIP_WAITING });
}

/** User-chosen view refresh only. Never asks the host to stop or reload. */
export function refreshFrontend(): void {
  if (waiting) applyUpdate();
  else window.location.reload();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useServiceWorker(): ServiceWorkerSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Test seam. */
export function resetServiceWorkerState(): void {
  snapshot = { supported: false, registered: false, updateReady: false };
  registration = undefined;
  waiting = undefined;
}
