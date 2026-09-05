/**
 * Web Push: the payload shape, and the subscription shapes the host stores.
 *
 * One push payload, two platforms.
 *
 * The shape is the Declarative Web Push document (`application/notification+json`,
 * `web_push: 8030`): Safari shows it without waking a service worker, and iOS
 * has no other kind of push. Chromium and Firefox do not implement declarative
 * push, so `sw.ts` reads the same document in its `push` handler and calls
 * `showNotification` with it. The host builds exactly one document per event
 * and never branches on the device.
 *
 * Only Chromium renders `actions` as buttons; Safari ignores them and the whole
 * notification is one tap-to-open. `navigate` is therefore always present and
 * always sufficient on its own (docs/mobile.md).
 *
 * Pure types and pure functions only — no Node and no DOM — so the host, the
 * page and the service worker can all share one definition. (The service
 * worker keeps its own three-line guard, because it is emitted as a single
 * standalone file with no import graph.)
 */

/** A `PushSubscription.toJSON()` as the page sends it to the host. */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** How a person recognises one of their devices in the settings list. */
export interface PushDeviceInfo {
  /** "iPhone · Safari", "Pixel · Chrome". Untrusted text; never rendered as markup. */
  label: string;
  platform: "ios" | "android" | "other";
  /** Installed to the home screen when it subscribed. */
  standalone: boolean;
}

/** Answer to `pi/push/config`: can this host send notifications, and if not, why. */
export interface PushConfig {
  enabled: boolean;
  /** base64url, uncompressed P-256 point; the `applicationServerKey`. */
  vapidPublicKey?: string;
  /** Why `enabled` is false, in words for a person. */
  reason?: string;
}

export const DECLARATIVE_WEB_PUSH_VERSION = 8030;

export interface DeclarativePushAction {
  /** Stable id echoed back as `NotificationEvent.action`. */
  action: string;
  title: string;
  /** Where a tap on this button goes. Same-origin absolute URL. */
  navigate: string;
}

export interface DeclarativePushNotification {
  title: string;
  body?: string;
  /** Where a tap on the notification body goes. Same-origin absolute URL. */
  navigate: string;
  /** Replaces an earlier notification with the same tag rather than stacking. */
  tag?: string;
  lang?: string;
  dir?: "auto" | "ltr" | "rtl";
  icon?: string;
  badge?: string;
  silent?: boolean;
  renotify?: boolean;
  require_interaction?: boolean;
  /** Free-form; the page reads it after a click. */
  data?: unknown;
  actions?: DeclarativePushAction[];
}

export interface DeclarativePushPayload {
  web_push: typeof DECLARATIVE_WEB_PUSH_VERSION;
  notification: DeclarativePushNotification;
  /** Safari: let the service worker rewrite the notification before display. We never do. */
  mutable?: boolean;
}

/** What a decision notification carries, for the page that opens from it. */
export interface DecisionPushData {
  kind: "decision";
  sessionPath: string;
  decisionId: string;
}

export function isDeclarativePushPayload(value: unknown): value is DeclarativePushPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v["web_push"] !== DECLARATIVE_WEB_PUSH_VERSION) return false;
  const n = v["notification"];
  if (!n || typeof n !== "object") return false;
  const note = n as Record<string, unknown>;
  return typeof note["title"] === "string" && typeof note["navigate"] === "string";
}

/**
 * Build the URL a notification (or one of its buttons) opens.
 *
 * The decision lives in the query string and the session in the hash on
 * purpose: the app's existing deep link is `#/session/<path>` and consumes the
 * hash, so the decision must not be inside it. Order: `?decision=…&answer=…`
 * then `#/session/…`.
 */
export function decisionNavigateUrl(
  origin: string,
  sessionPath: string,
  decisionId: string,
  answer?: "allow" | "deny",
): string {
  const params = new URLSearchParams({ decision: decisionId });
  if (answer) params.set("answer", answer);
  return `${origin.replace(/\/$/, "")}/?${params.toString()}#/session/${encodeURIComponent(sessionPath)}`;
}

export interface DecisionPushInput {
  origin: string;
  sessionPath: string;
  /** Last path segment of the project, for the title. */
  projectName: string;
  decisionId: string;
  /** The dialog's title, e.g. "Allow bash?" or "Pick one". */
  title: string;
  /** The dialog's message, when it has one. Clipped to a notification-sized line. */
  message?: string | undefined;
  /** Only a yes/no question gets Allow / Deny buttons. Anything else is tap-to-open. */
  yesNo: boolean;
}

const BODY_LIMIT = 160;

export function clipForNotification(text: string, limit = BODY_LIMIT): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  // Cut on a word boundary when there is one in the last fifth.
  const cut = oneLine.lastIndexOf(" ", limit - 1);
  return `${oneLine.slice(0, cut > limit * 0.8 ? cut : limit - 1).trimEnd()}…`;
}

/**
 * The one document the host sends when a session starts waiting for a person.
 * Tagged by decision id so a re-send (relay retry, second device) replaces
 * rather than duplicates (R9).
 */
export function decisionPushPayload(input: DecisionPushInput): DeclarativePushPayload {
  const navigate = decisionNavigateUrl(input.origin, input.sessionPath, input.decisionId);
  const data: DecisionPushData = { kind: "decision", sessionPath: input.sessionPath, decisionId: input.decisionId };
  const body = input.message ? clipForNotification(`${input.title} — ${input.message}`) : clipForNotification(input.title);
  return {
    web_push: DECLARATIVE_WEB_PUSH_VERSION,
    notification: {
      title: `${input.projectName} needs you`,
      body,
      navigate,
      tag: `decision:${input.decisionId}`,
      icon: `${input.origin.replace(/\/$/, "")}/icons/icon-192.png`,
      badge: `${input.origin.replace(/\/$/, "")}/icons/badge-96.png`,
      require_interaction: true,
      data,
      ...(input.yesNo
        ? {
            actions: [
              { action: "allow", title: "Allow", navigate: decisionNavigateUrl(input.origin, input.sessionPath, input.decisionId, "allow") },
              { action: "deny", title: "Deny…", navigate: decisionNavigateUrl(input.origin, input.sessionPath, input.decisionId, "deny") },
            ],
          }
        : {}),
    },
  };
}
