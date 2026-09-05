/**
 * Web Push on the page side.
 *
 * The host owns the VAPID key pair and the subscription store (`pi/push/*`);
 * the page asks permission from a tap, subscribes through the service worker,
 * and hands the subscription to the host. On every start it re-sends the
 * subscription it already holds, so a browser-side rotation or a host-side
 * reset heals without anyone noticing.
 *
 * Platform truth (docs/mobile.md): Safari needs the app on the home screen
 * before `PushManager` exists at all; Android shows Allow / Deny buttons on
 * the notification, iOS shows one tap-to-open. The payload is one document
 * for both (`@lasercode/protocol`, `src/push.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readEnvironment, type PwaEnvironment } from "./environment.js";
import { extendedRequest, type PushDeviceInfo, type PushSubscriptionJson, type RawRequestClient } from "./host-rpc.js";
import { getServiceWorkerRegistration } from "./register.js";

export type PushAvailability =
  /** No secure context, or no PushManager on this browser. */
  | { state: "unsupported"; reason: string }
  /** iOS Safari, not installed. */
  | { state: "needs-home-screen" }
  /** The host has no VAPID keys / storage. */
  | { state: "host-disabled"; reason: string }
  | { state: "denied" }
  | { state: "ready"; granted: boolean };

export function pushAvailability(env: PwaEnvironment, permission: NotificationPermission | undefined, hostEnabled: boolean | undefined, hostReason?: string): PushAvailability {
  if (!env.secure) return { state: "unsupported", reason: "Notifications need a secure address (https)." };
  if (env.needsHomeScreenForPush && !env.push) return { state: "needs-home-screen" };
  if (!env.push) return { state: "unsupported", reason: "This browser cannot receive web push." };
  if (hostEnabled === false) return { state: "host-disabled", reason: hostReason ?? "The desktop has push switched off." };
  if (permission === "denied") return { state: "denied" };
  return { state: "ready", granted: permission === "granted" };
}

/** base64url → the `applicationServerKey` bytes. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** "iPhone · Safari" — a label a person recognises in a device list. Untrusted text. */
export function deviceLabel(userAgent: string, platform: PwaEnvironment["platform"]): string {
  const device =
    /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : platform === "ios" ? "iPad" : /Android/.test(userAgent) ? (/Pixel/.test(userAgent) ? "Pixel" : "Android") : "Browser";
  const browser = /CriOS|Chrome\//.test(userAgent) && !/Edg\//.test(userAgent) ? "Chrome" : /Edg\//.test(userAgent) ? "Edge" : /FxiOS|Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "browser";
  return `${device} · ${browser}`;
}

export function subscriptionToJson(subscription: PushSubscription): PushSubscriptionJson {
  const json = subscription.toJSON();
  const p256dh = json.keys?.["p256dh"];
  const auth = json.keys?.["auth"];
  if (!json.endpoint || !p256dh || !auth) throw new Error("The browser returned an incomplete push subscription.");
  return { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh, auth } };
}

function deviceInfo(env: PwaEnvironment): PushDeviceInfo {
  return { label: deviceLabel(navigator.userAgent, env.platform), platform: env.platform, standalone: env.standalone };
}

/**
 * Subscribe this browser and register it with the host. Call from a tap: the
 * permission prompt only opens on a user gesture.
 */
export async function enablePush(client: RawRequestClient): Promise<PushSubscriptionJson> {
  const registration = await readyRegistration();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushPermissionError(permission);
  const config = await extendedRequest(client, "pi/push/config", {});
  if (!config.enabled || !config.vapidPublicKey) throw new Error(config.reason ?? "The desktop has push switched off.");
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey) as BufferSource,
    }));
  const json = subscriptionToJson(subscription);
  await extendedRequest(client, "pi/push/subscribe", { subscription: json, device: deviceInfo(readEnvironment()) });
  return json;
}

export async function disablePush(client: RawRequestClient): Promise<void> {
  const registration = getServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await extendedRequest(client, "pi/push/unsubscribe", { endpoint }).catch(() => {
    // The host keeps a subscription that can no longer deliver; its next send
    // gets a 404/410 and it drops the row. Nothing for the person to do.
  });
}

/**
 * Re-register the subscription this browser already holds. Idempotent on the
 * host (upsert by endpoint). Cheap, so it runs on every start while permission
 * is granted, and after the worker reports `pushsubscriptionchange`.
 */
export async function syncPushSubscription(client: RawRequestClient, override?: PushSubscriptionJson): Promise<boolean> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const json = override ?? (await currentSubscription());
  if (!json) return false;
  await extendedRequest(client, "pi/push/subscribe", { subscription: json, device: deviceInfo(readEnvironment()) });
  return true;
}

export async function currentSubscription(): Promise<PushSubscriptionJson | undefined> {
  const registration = getServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? subscriptionToJson(subscription) : undefined;
}

/**
 * `navigator.serviceWorker.ready` never settles when nothing is registered
 * (the dev server, a failed install), so it is raced against a short timeout
 * rather than trusted.
 */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const known = getServiceWorkerRegistration();
  if (known) return known;
  const noWorker = new Error("The app has no service worker here, so it cannot receive notifications.");
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) throw noWorker;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
  ]);
  if (!registration) throw noWorker;
  return registration;
}

export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(permission === "denied" ? "Notifications are blocked for this site." : "Notifications were not allowed.");
    this.name = "PushPermissionError";
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UsePush {
  availability: PushAvailability;
  /** This browser holds a subscription registered with the host. */
  subscribed: boolean;
  busy: boolean;
  /** The last failure, in words. Cleared on the next attempt. */
  error: string | undefined;
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** Ask the host to send a test notification to this device. */
  test(): Promise<void>;
}

export function usePush(client: RawRequestClient | undefined, env: PwaEnvironment): UsePush {
  const [permission, setPermission] = useState<NotificationPermission | undefined>(() =>
    typeof Notification !== "undefined" ? Notification.permission : undefined,
  );
  const [host, setHost] = useState<{ enabled: boolean; reason?: string } | undefined>(undefined);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Learn the host's stance once and this browser's subscription, and re-sync it.
  useEffect(() => {
    if (!client || !env.push) return;
    let cancelled = false;
    void (async () => {
      try {
        const config = await extendedRequest(client, "pi/push/config", {});
        if (cancelled) return;
        setHost({ enabled: config.enabled, ...(config.reason ? { reason: config.reason } : {}) });
        const synced = await syncPushSubscription(client);
        if (!cancelled) setSubscribed(synced);
      } catch (error) {
        // Not connected yet: leave it optimistic, the tap will explain. A host
        // that answered with an error genuinely cannot do push (older host, no
        // `pi/push/*`), and the setting should say so instead of offering a tap.
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled && !/^Not connected to the host\.$/.test(message)) {
          setHost({ enabled: false, reason: `The desktop cannot send notifications yet: ${message}` });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, env.push]);

  const enable = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      await enablePush(client);
      setSubscribed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (typeof Notification !== "undefined") setPermission(Notification.permission);
      if (mounted.current) setBusy(false);
    }
  }, [client]);

  const disable = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      await disablePush(client);
      setSubscribed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client]);

  const test = useCallback(async () => {
    if (!client) return;
    setError(undefined);
    try {
      const current = await currentSubscription();
      if (!current) throw new Error("This device is not subscribed.");
      const result = await extendedRequest(client, "pi/push/test", { endpoint: current.endpoint });
      if (!result.delivered) throw new Error(result.error ?? "The push service did not accept the message.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  const availability = useMemo(() => pushAvailability(env, permission, host?.enabled, host?.reason), [env, permission, host]);
  return { availability, subscribed, busy, error, enable, disable, test };
}
