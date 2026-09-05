/**
 * The slice of the ServiceWorker global scope `sw.ts` uses.
 *
 * The UI package compiles against the DOM lib; adding the `webworker` lib to
 * the same program collides on dozens of globals. These are the handful of
 * worker-only shapes the service worker touches, declared narrowly so the
 * worker is type-checked with the rest of `src` instead of being an untyped
 * `.js` file nobody reads.
 */

export interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

export interface PushMessageDataLike {
  json(): unknown;
  text(): string;
}

export interface PushEventLike extends ExtendableEventLike {
  readonly data: PushMessageDataLike | null;
}

export interface NotificationEventLike extends ExtendableEventLike {
  readonly notification: Notification;
  /** Empty string when the body of the notification was tapped. */
  readonly action: string;
}

export interface PushSubscriptionChangeEventLike extends ExtendableEventLike {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
}

export interface ExtendableMessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
}

export interface WindowClientLike {
  readonly id: string;
  readonly url: string;
  readonly focused: boolean;
  readonly visibilityState: "hidden" | "visible";
  focus(): Promise<WindowClientLike>;
  postMessage(message: unknown): void;
}

export interface ClientsLike {
  matchAll(options?: { type?: "window"; includeUncontrolled?: boolean }): Promise<WindowClientLike[]>;
  openWindow(url: string): Promise<WindowClientLike | null>;
  claim(): Promise<void>;
}

/** `NotificationOptions` plus the worker-only members the DOM lib leaves out. */
export interface WorkerNotificationOptions extends NotificationOptions {
  actions?: Array<{ action: string; title: string; icon?: string }>;
  renotify?: boolean;
  requireInteraction?: boolean;
  timestamp?: number;
}

export interface ServiceWorkerRegistrationLike {
  readonly pushManager: PushManager;
  showNotification(title: string, options?: WorkerNotificationOptions): Promise<void>;
  getNotifications(options?: { tag?: string }): Promise<Notification[]>;
}

export interface ServiceWorkerScope {
  readonly location: Location;
  readonly registration: ServiceWorkerRegistrationLike;
  readonly clients: ClientsLike;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEventLike) => void): void;
  addEventListener(type: "pushsubscriptionchange", listener: (event: PushSubscriptionChangeEventLike) => void): void;
  addEventListener(type: "message", listener: (event: ExtendableMessageEventLike) => void): void;
}
