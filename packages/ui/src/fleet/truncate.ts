/**
 * Truncation order for fleet rows (source-control leap §3 A.3, M17-T19
 * generalised). Pure: no DOM.
 *
 *   - a verb is never sliced;
 *   - a path middle-truncates, keeping the tail;
 *   - a branch or worktree name keeps its suffix;
 *   - the full string is the tooltip and the accessible name, never this cut.
 */

/** A path-shaped value at 12px mono in a 320px column. */
export const PATH_BUDGET = 24;
/** A branch/worktree name in the developer strip. */
export const BRANCH_BUDGET = 14;

export function isPathShaped(value: string): boolean {
  return /[\\/]/.test(value) || /^(?:\.{1,2}|~)[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/** Keep the start and the tail; the ellipsis sits in the middle. */
export function middleTruncate(value: string, max: number = PATH_BUDGET): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max === 1) return "…";
  const inner = max - 1;
  const tail = Math.max(1, Math.ceil(inner * 0.6));
  const head = Math.max(0, inner - tail);
  if (head === 0) return `…${value.slice(-inner)}`;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Drop the start; keep the suffix so `agents/…6a5fb144` still identifies. */
export function suffixTruncate(value: string, max: number = BRANCH_BUDGET): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max === 1) return "…";
  return `…${value.slice(-(max - 1))}`;
}

/** First sentence of a result, so a finished row is not a paragraph. */
export function firstSentence(value: string): string {
  const one = value.replace(/\s+/g, " ").trim();
  if (!one) return one;
  const match = one.match(/^(.+?[.!?])(?:\s|$)/);
  return match?.[1] ?? one;
}

/**
 * Short model id a developer strip can hold: last path segment, no provider
 * prefix. `anthropic/claude-opus-4` → `claude-opus-4`.
 */
export function shortModelName(id: string, name?: string): string {
  const raw = (name && name.length > 0 && name.length <= id.length ? name : id).trim();
  const last = raw.split(/[/:]/).filter(Boolean).at(-1) ?? raw;
  return last;
}

/** Two letters from an agent name: `worker` → `WK`, `code-reviewer` → `CR`. */
export function agentInitials(name: string): string {
  const words = name.replace(/[-_.]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]![0] ?? "";
    const second = words[1]![0] ?? "";
    return (first + second).toUpperCase();
  }
  const word = words[0] ?? "?";
  return word.slice(0, 2).toUpperCase();
}
