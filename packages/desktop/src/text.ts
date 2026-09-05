/**
 * Turning agent output into something safe to hand the operating system.
 *
 * Session names, project names and tool summaries all come from the agent, and
 * they end up in a window title, a tray menu and a notification body. None of
 * those escape anything for us: a newline in a menu item breaks the menu, an
 * ANSI escape can move a terminal's cursor, and a very long name pushes the
 * rest of a tray menu off screen. Invariant 9 (phone output is untrusted data)
 * applies to native chrome exactly as it does to the DOM.
 *
 * The truncation rule is the one from the legibility floor in DESIGN.md:
 * shorten by dropping characters, never by squeezing them.
 */

/** Control characters, bidi overrides, and the separators that break menus. */
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export function plainText(value: string, max = 96): string {
  const flat = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // A real ellipsis, and one character of slack so the result is never longer
  // than `max` on a platform that counts code units.
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** The last segment of a path, for a project label. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

/**
 * A short age, for tray rows. Menus have no room for "3 minutes ago" times
 * twenty, and the exact minute is never the question — "is this the one I was
 * just in" is.
 */
export function shortAge(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** "1 running · 2 need you", with the halves that are zero left out. */
export function fleetSummary(running: number, waiting: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (waiting > 0) parts.push(waiting === 1 ? "1 needs you" : `${waiting} need you`);
  return parts.join(" · ");
}
