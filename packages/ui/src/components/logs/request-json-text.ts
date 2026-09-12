/** Captured payloads are immutable. Materialize the complete diagnostic JSON
 * only on explicit copy/full-text search, then reuse that exact string for both.
 * Lifetime belongs to the mounted capture/field, not a global payload cache.
 */
export function createRequestJsonText(value: unknown, serialize = (input: unknown) => JSON.stringify(input, null, 2) ?? ""): () => string {
  let text: string | undefined;
  return () => text ??= serialize(value);
}
