/** Small display helpers shared by components. Pure. */

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  // A million-token context is a real model, and "1000k" is not how anyone
  // writes it. Past a million the unit changes rather than the digits growing.
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const millions = n / 1_000_000;
  return `${millions < 10 ? millions.toFixed(millions % 1 === 0 ? 0 : 1) : Math.round(millions)}M`;
}

export function money(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-1)[0] ?? cwd;
}

export function initials(name: string): string {
  const words = name.replace(/[-_.]/g, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Stable hue from a string, for project avatars. */
export function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function summariseArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const key = ["command", "path", "file_path", "pattern", "query", "url", "cmd"].find((k) => typeof a[k] === "string");
  if (key) return String(a[key]).replace(/\s+/g, " ").slice(0, 140);
  const keys = Object.keys(a);
  return keys.length ? keys.slice(0, 3).join(", ") : "";
}

export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** `14:05` in the viewer's locale, for dense rows where the date is implied. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** `Sep 5, 14:05` for tooltips. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function percent(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)}%` : "—";
}

/** Single-line, ellipsised. */
export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `⌘` on Apple platforms, `Ctrl` elsewhere. */
export function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") || /Mac OS X/.test(navigator.userAgent ?? "") ? "⌘" : "Ctrl";
}

/** `⌘N` / `Ctrl+N` — the platform's modifier joined to a key for Kbd labels. */
export function shortcutLabel(key: string): string {
  const mod = modKey();
  return mod === "⌘" ? `${mod}${key}` : `${mod}+${key}`;
}
