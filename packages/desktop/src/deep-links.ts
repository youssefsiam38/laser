/**
 * `laser://` links (M5-T1).
 *
 * Three shapes, and deliberately only three:
 *
 *   laser://session/<absolute session file path>
 *   laser://project/<absolute project directory>
 *   laser://open
 *
 * The payload is a filesystem path, which is the one thing a URL is bad at: it
 * can contain `/`, `?`, `#`, spaces and, on Windows, a backslash and a colon.
 * So the canonical form percent-encodes the whole path into a single segment
 * (`build()` does that), and the parser also accepts the unencoded form that
 * people type by hand — `laser://session//home/me/p/s.jsonl` — because a link
 * that only works when it was machine-generated is a link that fails in an
 * issue report.
 *
 * Everything here is pure so it can be tested without an Electron process; the
 * queueing side lives in `main.ts`.
 */
import type { DeepLink } from "./api.js";
import { DEEP_LINK_SCHEME } from "./api.js";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Absolute-path test that holds for both platforms, whichever we run on. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || WINDOWS_ABSOLUTE.test(value);
}

function decodeSegment(raw: string): string | undefined {
  try {
    // `+` is a form-encoding convention, not a URL-path one: a path segment
    // that contains a plus sign means a plus sign.
    const decoded = decodeURIComponent(raw);
    return decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined; // A malformed escape: not a link we can act on.
  }
}

/**
 * Parse one link. Returns `undefined` for anything that is not a laser link
 * we understand, so a caller can ignore junk without a try/catch.
 */
export function parseDeepLink(input: string): DeepLink | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return undefined;

  // A non-special scheme has an *opaque* host, which `new URL` leaves exactly
  // as written (verified: `laser://Open` keeps its capital). So the verb is
  // lowercased here, while the path — which is case-sensitive on every
  // filesystem we care about — is not.
  const verb = url.hostname.toLowerCase();
  const fromQuery = url.searchParams.get("path") ?? url.searchParams.get("cwd") ?? undefined;
  const fromPath = url.pathname.replace(/^\//, "");
  const raw = fromPath.length > 0 ? decodeSegment(fromPath) : fromQuery;

  switch (verb) {
    case "open":
      return { kind: "open" };
    case "session": {
      if (!raw || !isAbsolutePath(raw)) return undefined;
      return { kind: "session", path: raw };
    }
    case "project": {
      if (!raw || !isAbsolutePath(raw)) return undefined;
      return { kind: "project", cwd: raw };
    }
    default:
      return undefined;
  }
}

/** The canonical form. `parseDeepLink(buildDeepLink(x))` is `x`. */
export function buildDeepLink(link: DeepLink): string {
  switch (link.kind) {
    case "open":
      return `${DEEP_LINK_SCHEME}://open`;
    case "session":
      return `${DEEP_LINK_SCHEME}://session/${encodeURIComponent(link.path)}`;
    case "project":
      return `${DEEP_LINK_SCHEME}://project/${encodeURIComponent(link.cwd)}`;
  }
}

/**
 * Windows and Linux deliver a link as an argument to a second launch, mixed in
 * with Chromium's own switches and, in development, the script path. Take the
 * last one: if a user activated two links before we woke up, the newest is the
 * one they are waiting on.
 */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | undefined {
  for (let i = argv.length - 1; i >= 0; i--) {
    const candidate = argv[i];
    if (candidate === undefined) continue;
    if (!candidate.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) continue;
    const link = parseDeepLink(candidate);
    if (link) return link;
  }
  return undefined;
}
