/**
 * How a reply's reasoning reads when a model wrote it in more than one piece.
 *
 * A provider emits a reasoning summary as a sequence of segments — each one a
 * short titled paragraph of its own ("**Handling loading state**…", then
 * "**Implementing safe fallback**…"). Joining them with nothing runs the end of
 * one title straight into the start of the next, so the person reads a single
 * unbroken line that no renderer can recover the structure of.
 *
 * A blank line is the separator, in one place, because five layers have to
 * agree on it byte for byte: what `session/entry_range` serves, the
 * `totalBytes` the protocol publishes for that body, the `totalBytes` the
 * renderer mints for a reference of its own, the live tail a streaming turn
 * shows, and the transcript row underneath. Two bytes of disagreement at any
 * boundary is not a wrong number on screen — it is a refused read.
 *
 * Prose parts keep their empty join: a model's reply arrives in tokens, not in
 * paragraphs, and separating those would insert breaks the model never wrote.
 */

/** The blank line between two reasoning segments of one reply. */
export const REASONING_SEGMENT_SEPARATOR = "\n\n";

/**
 * The separator between the parts of one body, by the part type they came in.
 * Only reasoning is segmented; everything else is a stream of text.
 */
export function bodyPartSeparator(partType: string): string {
  return partType === "thinking" ? REASONING_SEGMENT_SEPARATOR : "";
}

/**
 * The same separator, for a body named the way a reference names it: the
 * `reasoning` component of an entry is exactly what its `thinking` parts are.
 * A view that holds a body in pieces has to spend the separators the authority
 * serving that body will write, or the two disagree about its size.
 */
export function bodyComponentSeparator(componentKind: string): string {
  return componentKind === "reasoning" ? REASONING_SEGMENT_SEPARATOR : "";
}

/**
 * An empty segment carries nothing, so it never spends a separator: a provider
 * that opens a segment it does not fill must not add a blank line to the body.
 * Both the text and its size are taken from this one rule.
 */
export function meaningfulSegments(segments: Iterable<string>): string[] {
  const kept: string[] = [];
  for (const segment of segments) if (segment !== "") kept.push(segment);
  return kept;
}

/** The reasoning body of one reply, from its segments in order. */
export function joinReasoningSegments(segments: Iterable<string>): string {
  return meaningfulSegments(segments).join(REASONING_SEGMENT_SEPARATOR);
}
