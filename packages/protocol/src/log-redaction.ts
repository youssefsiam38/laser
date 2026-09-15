/**
 * The one credential projection (RP-7).
 *
 * This used to live in the host's log store, which was the only place that
 * ever held a provider payload. RP-7 moves the *serialization* of a capture to
 * the process that already has the payload in memory — the worker — so the
 * body crosses the wire once, already redacted, and the host never rebuilds
 * it. That only stays honest if both sides run identical code, so the
 * algorithm lives here, in the package both of them already speak, and the
 * host keeps applying it to every other row exactly as before.
 *
 * The host also keeps a second, cheaper guard for text it did not redact
 * itself ({@link findCredentialShapedKeys}). It reports key *names* only:
 * a defence that printed the value it caught would be the leak it exists to
 * prevent.
 */

/**
 * Field names whose values never belong in a log row.
 *
 * Anchored, with up to two vendor prefix segments (`x-api-key`,
 * `anthropic-api-key`, `x-goog-api-key`) — deliberately not a substring match,
 * because Pi's own payloads are full of `max_tokens`, `reserveTokens` and
 * `thinkingBudgets`, and redacting those would make every row a lie in the
 * other direction.
 */
export const SECRET_KEY =
  /^([a-z0-9]+[-_]){0,2}(authorization|proxy-authorization|www-authenticate|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|cookie|set-cookie|session[-_]?token|auth[-_]?token|bearer|credential|credentials)$/i;

/** Deepest structure walked when redacting; a payload is JSON, not a graph. */
export const REDACT_MAX_DEPTH = 12;

/** What a redacted value carries instead of its credential. */
export const REDACTED = "[redacted]";

/**
 * Replace credential-shaped values with `[redacted]`, everywhere, and say how
 * many were replaced. Structure is preserved so the row still reads normally.
 */
export function redact(value: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > REDACT_MAX_DEPTH || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = REDACTED;
        count += 1;
        continue;
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return { value: walk(value, 0), count };
}

/** Same JSON-key grammar as {@link SECRET_KEY}, matched inside serialized text. */
const SECRET_KEY_IN_JSON =
  /"([a-z0-9]+[-_]){0,2}(authorization|proxy-authorization|www-authenticate|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|cookie|set-cookie|session[-_]?token|auth[-_]?token|bearer|credential|credentials)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]\s]+)/gi;

/**
 * One bounded pass over already-serialized JSON looking for a credential-shaped
 * key whose value is not the redaction sentinel — the host's defence against a
 * producer that did not redact (an older worker generation, a bug, a hostile
 * extension).
 *
 * Returns the matched **key names**, never values, and never more than `limit`
 * of them, so the caller can refuse and explain without holding or printing
 * anything sensitive.
 */
export function findCredentialShapedKeys(text: string, limit = 8): string[] {
  const found: string[] = [];
  SECRET_KEY_IN_JSON.lastIndex = 0;
  for (let match = SECRET_KEY_IN_JSON.exec(text); match !== null; match = SECRET_KEY_IN_JSON.exec(text)) {
    const value = match[3] ?? "";
    if (value === `"${REDACTED}"`) continue;
    const key = match[0].slice(1, match[0].indexOf('"', 1));
    if (!found.includes(key)) found.push(key);
    if (found.length >= limit) break;
  }
  return found;
}
