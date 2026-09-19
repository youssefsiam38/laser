/** Person-facing copy when the overlay cannot talk to a data adapter. */
export const CHANGES_UNAVAILABLE = "Changes are not available in this view.";
export const CHANGES_NEED_SESSION = "Open a conversation to see its changes.";
export const CHANGES_LIST_FAILED = "Could not read the changes. Try again, or pick another scope.";
export const CHANGES_FILE_FAILED = "Could not read this file. Try again, or pick another file.";
export const CHANGES_RANGE_FAILED = "That commit range could not be resolved. Check both ends.";

/** A sentence we already wrote for a person — keep it. Anything else is logged. */
export function isPersonFacingSentence(raw: string): boolean {
  if (raw.length < 8 || raw.length > 240) return false;
  if (/[\n\r]/.test(raw)) return false;
  if (/\b(?:TypeError|ReferenceError|SyntaxError)\b/.test(raw)) return false;
  if (/\bat\s+\S+\s*\(/.test(raw)) return false;
  return /^[A-ZÀ-ÖØ-Þ]/.test(raw) && /[.?!]$/.test(raw);
}

export function personFacingChangesError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (isPersonFacingSentence(raw)) return raw;
  if (raw) console.warn("changes overlay:", raw);
  return fallback;
}
