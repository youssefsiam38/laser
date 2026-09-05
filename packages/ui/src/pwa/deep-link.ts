/**
 * A tap on a notification lands here.
 *
 * The URL is `/?decision=<id>[&answer=allow|deny]#/session/<path>`
 * (`@lasercode/protocol`, `src/push.ts`). The app's provider already consumes `#/session/…`; this
 * module owns the query string: it remembers the decision at boot (before the
 * provider strips anything), accepts the same URL from the service worker
 * when the app was already open, and hands the decision surface
 * (`panels/DecisionSurfaces.tsx`) one pending intent at a time.
 *
 * `answer=allow` is applied only if the decision is *still pending* when the
 * app has it on screen, and `answer=deny` never answers blind: it opens the
 * card in its rejection state, because "No" always has somewhere to go.
 */
import { useSyncExternalStore } from "react";

export type DecisionLinkAnswer = "allow" | "deny";

export interface DecisionLink {
  decisionId: string;
  answer?: DecisionLinkAnswer;
  sessionPath?: string;
  /** ms epoch when it was received; a stale intent is dropped rather than applied. */
  at: number;
}

/** Pure. `search` and `hash` as `location` gives them (with `?` / `#`). */
export function parseDecisionLink(search: string, hash: string, now = Date.now()): DecisionLink | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const decisionId = params.get("decision");
  if (!decisionId) return undefined;
  const answerRaw = params.get("answer");
  const answer: DecisionLinkAnswer | undefined = answerRaw === "allow" || answerRaw === "deny" ? answerRaw : undefined;
  const match = /^#\/session\/(.+)$/.exec(hash);
  let sessionPath: string | undefined;
  if (match?.[1]) {
    try {
      sessionPath = decodeURIComponent(match[1]);
    } catch {
      sessionPath = undefined;
    }
  }
  return { decisionId, ...(answer ? { answer } : {}), ...(sessionPath ? { sessionPath } : {}), at: now };
}

/** `location.search` without the decision parameters. Pure. */
export function stripDecisionParams(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete("decision");
  params.delete("answer");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** An intent older than this is not applied: the person is not looking at what they tapped. */
export const LINK_TTL_MS = 5 * 60_000;

let pending: DecisionLink | undefined;
const listeners = new Set<() => void>();

function publish(next: DecisionLink | undefined): void {
  pending = next;
  for (const l of listeners) l();
}

/** Called from `boot.ts` with the page URL; safe to call again with a worker-delivered URL. */
export function rememberDecisionLink(url: { search: string; hash: string }): DecisionLink | undefined {
  const link = parseDecisionLink(url.search, url.hash);
  if (link) publish(link);
  return link;
}

/** A `piorbit:navigate` message from the service worker (the app was already open). */
export function acceptNavigateMessage(data: unknown): DecisionLink | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as { type?: unknown; url?: unknown };
  if (d.type !== "piorbit:navigate" || typeof d.url !== "string") return undefined;
  try {
    const url = new URL(d.url, globalThis.location?.origin ?? "http://localhost");
    return rememberDecisionLink(url);
  } catch {
    return undefined;
  }
}

export function pendingDecisionLink(): DecisionLink | undefined {
  if (pending && Date.now() - pending.at > LINK_TTL_MS) publish(undefined);
  return pending;
}

/** The island took it. Also cleans the query string so a reload does not replay it. */
export function consumeDecisionLink(): void {
  publish(undefined);
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const cleaned = stripDecisionParams(search);
  if (cleaned !== search) window.history.replaceState(null, "", `${pathname}${cleaned}${hash}`);
}

export function usePendingDecisionLink(): DecisionLink | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    pendingDecisionLink,
    () => undefined,
  );
}

/** Test seam. */
export function resetDecisionLinks(): void {
  pending = undefined;
}
