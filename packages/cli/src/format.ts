/** Small formatters shared by the table-printing commands. */
import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";

/** "3m ago", "yesterday", "12 Mar" — short enough for a table column. */
export function ago(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** `~/projects/laser` — home collapsed, and only the last two segments. */
export function shortCwd(cwd: string): string {
  const home = homedir();
  const collapsed = cwd === home ? "~" : cwd.startsWith(`${home}${sep}`) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = collapsed.split(sep).filter(Boolean);
  if (parts.length <= 2) return collapsed;
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

/** The part of a session path a person can retype: its file name. */
export function sessionLabel(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`;
}

/** First `n` characters of an id, which is what the tables show. */
export function shortId(id: string, n = 8): string {
  return id.length > n ? id.slice(0, n) : id;
}

export function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
