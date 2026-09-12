/**
 * laser service worker — the app shell, and nothing else.
 *
 * Caches: `index.html`, the hashed `assets/*` bundle, the manifest, the icons
 * and the two self-hosted typefaces. That is the whole list. `/ws`, `/healthz`
 * and every other request go straight to the network; transcripts never touch
 * a cache. Nothing cross-origin is cached because nothing cross-origin is
 * fetched.
 *
 *   navigation   network first, cached shell when offline
 *   listed assets cache first/on demand (hashed names never change meaning)
 *   anything     network only
 *
 * Push: one Declarative Web Push document per event (`@lasercode/protocol`,
 * `src/push.ts`). Safari renders it itself; here, for Chromium, we render it.
 * A tap focuses an open laser window and hands it the URL, or opens one.
 *
 * Built by `vite-plugin.ts`: the two placeholders below are replaced with the
 * emitted file list and a content hash, and the result is emitted as `/sw.js`.
 * The `.ts` is type-checked against `sw-types.ts` with the rest of `src`.
 *
 * It imports nothing: `/sw.js` is emitted as one standalone file, so the
 * notification shape is restated here as a structural type and a three-line
 * guard rather than shipping a bundler to inline one module. The document it
 * describes is `DeclarativePushPayload` in `@lasercode/protocol`; the plugin
 * refuses to emit a worker whose `DECLARATIVE_WEB_PUSH_VERSION` disagrees
 * with the protocol's, which is the one value that could drift silently.
 */
import type { ServiceWorkerScope, WindowClientLike, WorkerNotificationOptions } from "./sw-types.js";

declare const self: ServiceWorkerScope;

/** Mirrors `DeclarativePushNotification` in @lasercode/protocol. */
interface DeclarativePushNotification {
  title: string;
  body?: string;
  navigate: string;
  tag?: string;
  lang?: string;
  dir?: "auto" | "ltr" | "rtl";
  icon?: string;
  badge?: string;
  silent?: boolean;
  renotify?: boolean;
  require_interaction?: boolean;
  data?: unknown;
  actions?: Array<{ action: string; title: string; navigate: string }>;
}

/** The `web_push` version of the Declarative Web Push document we send. */
const DECLARATIVE_WEB_PUSH_VERSION = 8030;

function isDeclarativePushPayload(value: unknown): value is { notification: DeclarativePushNotification } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v["web_push"] !== DECLARATIVE_WEB_PUSH_VERSION) return false;
  const note = v["notification"];
  if (!note || typeof note !== "object") return false;
  const n = note as Record<string, unknown>;
  return typeof n["title"] === "string" && typeof n["navigate"] === "string";
}

/** Replaced at build time with the precache list (a JSON array of same-origin paths). */
const PRECACHE: readonly string[] = "__SW_PRECACHE__" as unknown as readonly string[];
/** Includes optional modules: allowed to cache, not mandatory install fetches. */
const ASSETS: readonly string[] = "__SW_ASSETS__" as unknown as readonly string[];
/** Replaced at build time with a hash of the precache list and this file. */
const BUILD = "__SW_BUILD__";

/**
 * Replaced at build time with the product's own cache prefix.
 *
 * This file is compiled on its own and may import nothing at runtime, so it
 * cannot read `@lasercode/protocol`. `vite-plugin.ts` substitutes the value from
 * product.json, which is why a rename still reaches the service worker.
 */
const CACHE_PREFIX = "__SW_CACHE_PREFIX__";
/** Replaced at build time with the product's display name. */
const PRODUCT = "__SW_PRODUCT_NAME__";

/** Substituted like the rest; the worker imports nothing at runtime. */
const SW_SKIP_WAITING = "__SW_SKIP_WAITING__";
const SW_PUSH_CHANGED = "__SW_PUSH_CHANGED__";
const CACHE = `${CACHE_PREFIX}${BUILD}`;
const SHELL = "/index.html";

const allowedAssets = new Set(ASSETS);
const hashedAsset = (path: string) => /^\/assets\/.+-[\w-]{8,}\.(?:m?js|css|woff2?)$/.test(path);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const older = await Promise.all((await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE).map(name => caches.open(name)));
      const reusable = async (path: string) => {
        if (!hashedAsset(path)) return undefined;
        for (const previous of older) {
          const response = await previous.match(path);
          if (response?.ok) return response;
        }
        return undefined;
      };
      await Promise.all(PRECACHE.map(async path => {
        const saved = await reusable(path);
        if (saved) await cache.put(path, saved);
        // Unhashed shell files must be revalidated for this generation.
        else await cache.add(new Request(path, { cache: "reload" }));
      }));
      // Keep already-used optional hashed modules across upgrades. No network
      // warming: failure of an optional module must not prevent shell install.
      const critical = new Set(PRECACHE);
      for (const previous of older) {
        for (const request of await previous.keys()) {
          const path = new URL(request.url).pathname;
          if (!allowedAssets.has(path) || critical.has(path) || !hashedAsset(path)) continue;
          const saved = await previous.match(request);
          if (saved?.ok) await cache.put(request, saved).catch(() => {});
        }
      }
      // Do not skipWaiting here: the page offers "Reload" when an update is ready
      // (register.ts), so a phone never swaps its shell mid-approval.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type === SW_SKIP_WAITING) void self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/ws" || url.pathname === "/healthz" || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }
  if (allowedAssets.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function navigation(request: Request): Promise<Response> {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) return fresh;
    // The host answered with an error page: prefer the shell we know works.
    const shell = await (await caches.open(CACHE)).match(SHELL);
    return shell ?? fresh;
  } catch {
    const shell = await (await caches.open(CACHE)).match(SHELL);
    return shell ?? offlineFallback();
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok) {
    // Settle the write before returning, so the next offline visit can use it.
    // A quota failure must not hide a successful network read.
    await cache.put(request, fresh.clone()).catch(() => {});
  }
  return fresh;
}

/**
 * Only reachable when the shell was never cached (install failed) and the
 * network is gone. Static text, design tokens inline, no scripts.
 */
function offlineFallback(): Response {
  // The offline page cannot reach the app's stylesheet — it is what renders
  // when the app itself did not load — so its ground, ink and typeface are
  // inlined. They are *compiled from the shipped presets* by `vite-plugin.ts`
  // and substituted for the placeholder below, so this page is the app's own
  // default light and dark rather than a palette frozen in this file.
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${PRODUCT} — offline</title><style>__SW_OFFLINE_STYLE__</style><main><h1>You’re offline</h1><p>${PRODUCT} could not load because this device has no connection and the app was not saved for offline use yet. Reconnect and open it again.</p></main>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** The per-action URLs travel in `data` so `notificationclick` can find them. */
interface StoredNotificationData {
  navigate: string;
  actions: Record<string, string>;
  payload?: unknown;
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const parsed = safeJson(event.data);
      if (isDeclarativePushPayload(parsed)) {
        await show(parsed.notification);
        return;
      }
      // Every push must be user-visible; an unexpected body still shows as itself.
      const text = event.data?.text() ?? "";
      await show({ title: PRODUCT, body: text.slice(0, 160), navigate: `${self.location.origin}/` });
    })(),
  );
});

function safeJson(data: { json(): unknown } | null): unknown {
  try {
    return data?.json();
  } catch {
    return undefined;
  }
}

async function show(note: DeclarativePushNotification): Promise<void> {
  const actions: Record<string, string> = {};
  for (const a of note.actions ?? []) actions[a.action] = a.navigate;
  const data: StoredNotificationData = { navigate: note.navigate, actions, payload: note.data };
  const options: WorkerNotificationOptions = {
    ...(note.body !== undefined ? { body: note.body } : {}),
    ...(note.tag !== undefined ? { tag: note.tag, renotify: note.renotify ?? true } : {}),
    ...(note.icon !== undefined ? { icon: note.icon } : {}),
    ...(note.badge !== undefined ? { badge: note.badge } : {}),
    ...(note.lang !== undefined ? { lang: note.lang } : {}),
    ...(note.dir !== undefined ? { dir: note.dir } : {}),
    ...(note.silent !== undefined ? { silent: note.silent } : {}),
    ...(note.require_interaction !== undefined ? { requireInteraction: note.require_interaction } : {}),
    ...(note.actions?.length ? { actions: note.actions.map((a) => ({ action: a.action, title: a.title })) } : {}),
    data,
    timestamp: Date.now(),
  };
  await self.registration.showNotification(note.title, options);
}

self.addEventListener("notificationclick", (event) => {
  const data = (event.notification.data ?? {}) as Partial<StoredNotificationData>;
  const url = (event.action && data.actions?.[event.action]) || data.navigate || `${self.location.origin}/`;
  event.notification.close();
  event.waitUntil(openOrFocus(url));
});

/**
 * Prefer the laser window that is already open: it holds the live socket,
 * so handing it the URL is instant and keeps its state. Only open a new
 * window when there is none.
 */
async function openOrFocus(url: string): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const ours = clients.filter((c) => new URL(c.url).origin === self.location.origin);
  const target: WindowClientLike | undefined = ours.find((c) => c.focused) ?? ours.find((c) => c.visibilityState === "visible") ?? ours[0];
  if (target) {
    try {
      await target.focus();
    } catch {
      /* focus is best effort; the message still lands */
    }
    target.postMessage({ type: "lasercode:navigate", url });
    return;
  }
  await self.clients.openWindow(url);
}

/**
 * The browser rotated the subscription. Re-subscribe with the same server key
 * and tell any open page so it re-registers with the host; a page that opens
 * later re-syncs on start anyway (push.ts `syncPushSubscription`).
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options.applicationServerKey;
      if (!key) return;
      const fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: SW_PUSH_CHANGED, subscription: fresh.toJSON() });
    })(),
  );
});
