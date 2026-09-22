/**
 * Links into the embedded workspace (D-355, "Opening and closing").
 *
 * A link lands on the **exact entity at an exact revision**, so it carries all
 * four parts of an identity — `projectId + kind + entityId + revisionId` — and
 * never a path, a title or a key alone. The key is a person-facing handle that
 * can be renumbered by nothing and re-read by anything, but it is not the
 * identity, and a transcript from last week must not silently resolve to
 * whatever is current.
 *
 * Two spellings of the same thing:
 *
 * - the app's own hash route, `#/work/<projectId>/<kind>/<entityId>[/<rev>]`,
 *   the same shape as `#/session/<path>` the shell already answers to;
 * - the product scheme, `laser://work/…`, which the desktop hands to the page
 *   as that hash. `workLinkUrl` builds the copyable form.
 *
 * Everything here is pure except {@link readWorkLink} and
 * {@link consumeWorkLink}, which touch `location` and `history` and are
 * guarded for a renderer that has neither.
 */
import { URL_SCHEME_PREFIX, isProjectWorkKind, type ProjectWorkKind } from "@lasercode/protocol";

/** Where a link points. The project alone opens the backlog. */
export interface WorkLinkTarget {
  projectId: string;
  kind?: ProjectWorkKind;
  entityId?: string;
  /** The exact revision. Absent follows the entity's current pointer. */
  revisionId?: string;
}

const ROUTE = "work";

const encode = (value: string): string => encodeURIComponent(value);

const decode = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
};

/** `#/work/…` — what the address bar carries and what the shell consumes. */
export function formatWorkLinkHash(target: WorkLinkTarget): string {
  const parts = [ROUTE, encode(target.projectId)];
  if (target.entityId && target.kind) {
    parts.push(target.kind, encode(target.entityId));
    if (target.revisionId) parts.push(encode(target.revisionId));
  }
  return `#/${parts.join("/")}`;
}

/** `laser://work/…` — the form a person copies and another app can open. */
export function workLinkUrl(target: WorkLinkTarget): string {
  return `${URL_SCHEME_PREFIX}${formatWorkLinkHash(target).slice(2)}`;
}

/**
 * Parse any of the three spellings: a bare hash, a whole URL that has one, or
 * the product scheme. Returns nothing for a link that is not a work link and
 * for one whose parts do not make an identity — a malformed link is never
 * repaired into a plausible one.
 */
export function parseWorkLink(value: string): WorkLinkTarget | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;

  let route: string;
  if (text.toLowerCase().startsWith(URL_SCHEME_PREFIX)) route = text.slice(URL_SCHEME_PREFIX.length);
  else {
    const hashAt = text.indexOf("#/");
    if (hashAt === -1) return undefined;
    route = text.slice(hashAt + 2);
  }

  const [path = "", ...rest] = route.split(/[?#]/u);
  if (rest.length > 0 && path.length === 0) return undefined;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== ROUTE) return undefined;

  const projectId = segments[1] ? decode(segments[1]) : undefined;
  if (!projectId) return undefined;
  if (segments.length === 2) return { projectId };

  const kind = segments[2];
  const entityId = segments[3] ? decode(segments[3]) : undefined;
  // A kind with no entity, or an entity with no kind, is not an identity.
  if (!kind || !isProjectWorkKind(kind) || !entityId) return undefined;
  const revisionId = segments[4] ? decode(segments[4]) : undefined;
  return { projectId, kind, entityId, ...(revisionId ? { revisionId } : {}) };
}

/** The work link this window was opened with, if it was opened with one. */
export function readWorkLink(hash: string | undefined = globalThis.location?.hash): WorkLinkTarget | undefined {
  return hash ? parseWorkLink(hash) : undefined;
}

/**
 * Take the link out of the address bar once it has been honoured, so a reload
 * returns to wherever the person actually ended up rather than replaying the
 * link. Same gesture the session route uses.
 */
export function consumeWorkLink(): void {
  const location = globalThis.location as Location | undefined;
  if (!location || !parseWorkLink(location.hash ?? "")) return;
  globalThis.history?.replaceState(null, "", `${location.pathname}${location.search}`);
}

/** True when two targets name the same place, revision included. */
export function sameWorkLink(a: WorkLinkTarget | undefined, b: WorkLinkTarget | undefined): boolean {
  if (!a || !b) return a === b;
  return a.projectId === b.projectId && a.kind === b.kind && a.entityId === b.entityId && a.revisionId === b.revisionId;
}
