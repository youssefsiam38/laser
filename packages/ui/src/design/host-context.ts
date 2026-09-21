/**
 * Reading `/design from <route>` back out of a design (M21-T13).
 *
 * The three forms of `/design` all send one piece of text, and the text is the
 * design's brief (`docs/design-phase.md`, "`/design` — three forms"; D-352:
 * the text beside the command is the whole input). So `/design from /orders`
 * arrives here as a design whose brief begins `from /orders`, and the Design
 * tab opens its in-context panel already pointed at that page instead of
 * making the person type the route a second time.
 *
 * Deliberately narrow: only the `from` form, only at the start, and only a
 * route or a path — never a guess at what any other brief might have meant.
 */
const FROM_FORM = /^\s*(?:\/design\s+)?from\s+(\S+)/i;

/** The route or template path `/design from …` named, when it named one. */
export function routeFromBrief(brief: string): string | undefined {
  const match = FROM_FORM.exec(brief);
  const candidate = match?.[1];
  if (candidate === undefined) return undefined;
  // A route, a template path or a view name. Anything with whitespace, a
  // scheme or a parent-directory step is not one of those.
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) || candidate.includes("..")) return undefined;
  return candidate.length > 1024 ? undefined : candidate;
}

/** The `/design implement @KEY` form, as the composer takes it (M21-T17). */
export function implementCommandFor(workKey: string): string {
  return `/design implement @${workKey}`;
}
