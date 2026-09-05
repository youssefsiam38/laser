/**
 * What this page can and cannot do here, in one readable object.
 *
 * A LAN `http://` origin is not a secure context: no service worker, no push,
 * no microphone, no wake lock (docs/research/findings.md). Rather than let
 * each feature fail in its own way, the environment is read once and every
 * mobile surface asks it. Also: the install prompt, which has to be captured
 * before React mounts or it is gone.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { useSyncExternalStore } from "react";

export type MobilePlatform = "ios" | "android" | "other";

export interface PwaEnvironment {
  /** `window.isSecureContext`. Everything below `serviceWorker` depends on it. */
  secure: boolean;
  /** Running from the home screen (`display-mode: standalone` or Safari's `navigator.standalone`). */
  standalone: boolean;
  platform: MobilePlatform;
  /** Coarse pointer and no fine one: a phone or tablet, not a laptop with a touch screen. */
  touch: boolean;
  serviceWorker: boolean;
  push: boolean;
  notifications: boolean;
  microphone: boolean;
  mediaRecorder: boolean;
  online: boolean;
  /** The page origin, for messages that name it. */
  origin: string;
  /** Safari on iOS but not installed: push is impossible until Add to Home Screen. */
  needsHomeScreenForPush: boolean;
}

export function detectPlatform(userAgent: string, maxTouchPoints = 0): MobilePlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  // iPadOS 13+ reports a Mac user agent; touch points give it away.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
}

export function readEnvironment(): PwaEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      secure: false,
      standalone: false,
      platform: "other",
      touch: false,
      serviceWorker: false,
      push: false,
      notifications: false,
      microphone: false,
      mediaRecorder: false,
      online: true,
      origin: "",
      needsHomeScreenForPush: false,
    };
  }
  const secure = window.isSecureContext === true;
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const standalone = isStandalone();
  const serviceWorker = secure && "serviceWorker" in navigator;
  const push = serviceWorker && "PushManager" in window && "Notification" in window;
  return {
    secure,
    standalone,
    platform,
    touch: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse) and (not (any-pointer: fine))").matches,
    serviceWorker,
    push,
    notifications: secure && "Notification" in window,
    microphone: secure && typeof navigator.mediaDevices?.getUserMedia === "function",
    mediaRecorder: secure && typeof (window as Window & { MediaRecorder?: unknown }).MediaRecorder === "function",
    online: navigator.onLine !== false,
    origin: window.location.origin,
    // iOS exposes PushManager only to installed web apps; in Safari itself the
    // property is missing, so `push` is already false — this names the fix.
    needsHomeScreenForPush: platform === "ios" && !standalone,
  };
}

// ---------------------------------------------------------------------------
// Reactive environment
// ---------------------------------------------------------------------------

let current: PwaEnvironment | undefined;
const listeners = new Set<() => void>();
let wired = false;

function refresh(): void {
  current = readEnvironment();
  for (const l of listeners) l();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(display-mode: standalone)").addEventListener("change", refresh);
  }
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const SERVER_ENV = readEnvironment();

export function useEnvironment(): PwaEnvironment {
  return useSyncExternalStore(
    subscribe,
    () => (current ??= readEnvironment()),
    () => SERVER_ENV,
  );
}

// ---------------------------------------------------------------------------
// Install prompt (Chromium's `beforeinstallprompt`)
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | undefined;
const promptListeners = new Set<() => void>();
let promptWired = false;

/**
 * Must run before the event fires — which is early, often before React
 * mounts — so `boot.ts` calls this synchronously at module load.
 */
export function captureInstallPrompt(): void {
  if (promptWired || typeof window === "undefined") return;
  promptWired = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    for (const l of promptListeners) l();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = undefined;
    for (const l of promptListeners) l();
    refresh();
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== undefined;
}

/** Show the browser's install sheet. Resolves with the outcome; the prompt is single-use. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = deferredPrompt;
  if (!prompt) return "unavailable";
  deferredPrompt = undefined;
  for (const l of promptListeners) l();
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

export function useCanPromptInstall(): boolean {
  return useSyncExternalStore(
    (cb) => {
      promptListeners.add(cb);
      return () => promptListeners.delete(cb);
    },
    canPromptInstall,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export interface InsecureOriginAdvice {
  title: string;
  body: string;
  /** What is off here, as short labels. */
  missing: string[];
  /** The fix, in order. */
  steps: string[];
}

/** Written for a person who opened `http://192.168.x.x:41441` on their phone. */
export function insecureOriginAdvice(env: PwaEnvironment): InsecureOriginAdvice {
  const host = env.origin.replace(/^https?:\/\//, "");
  return {
    title: "This address can’t do everything",
    body: `You opened ${PRODUCT_NAME} over plain http at ${host}. Phones only allow installing, notifications, the microphone and offline use on a secure address.`,
    missing: ["Install to home screen", "Notifications", "Microphone", "Works offline"],
    steps: [
      `Open ${PRODUCT_NAME} through its relay link instead — that address is https and pairs this phone with your desktop.`,
      "Or trust a certificate for this address on the phone and open the https version.",
    ],
  };
}
