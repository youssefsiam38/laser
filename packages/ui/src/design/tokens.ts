/**
 * The index's tokens, as the frame needs them (M21-T11).
 *
 * The flattening itself is the protocol's (`designTokenCustomProperties`),
 * because the worker writes the document, the UI draws it and neither may
 * import the other. What is here is what a *surface* needs on top: the
 * families the inspector groups by, and the refusal a free value gets.
 *
 * "Free values are refused with the nearest token suggested"
 * (`docs/design-phase.md`, Case B) is one sentence in the contract and two
 * things on screen: a refusal that says why, and a suggestion that can be
 * applied with one press.
 */
import {
  designTokenCustomProperties,
  flattenDesignTokens,
  suggestTokenForValue,
  type DesignTokenGroup,
  type FlatDesignToken,
} from "@lasercode/protocol";

export interface FrameTokens {
  /** `--design-*` custom properties, ready for a shadow root's style. */
  properties: Record<string, string>;
  tokens: FlatDesignToken[];
  /** Tokens the frame refused to set, and why. Shown, never swallowed. */
  skipped: Array<{ path: string; reason: string }>;
}

export function frameTokens(document: DesignTokenGroup | undefined): FrameTokens {
  const flat = flattenDesignTokens(document);
  return { properties: designTokenCustomProperties(document), tokens: flat.tokens, skipped: flat.skipped };
}

/** `color.brand.500` → family `color`. What the token picker groups by. */
export function tokenFamilies(tokens: readonly FlatDesignToken[]): Array<{ family: string; tokens: FlatDesignToken[] }> {
  const families = new Map<string, FlatDesignToken[]>();
  for (const token of tokens) {
    const family = token.path.split(".")[0] ?? "other";
    families.set(family, [...(families.get(family) ?? []), token]);
  }
  return [...families.entries()].map(([family, list]) => ({ family, tokens: list })).sort((a, b) => a.family.localeCompare(b.family));
}

export interface FreeValueRefusal {
  /** Why the value was not taken, in one sentence for a person. */
  message: string;
  /** The token to use instead, when there is a near one. */
  suggestion?: FlatDesignToken;
}

/** Values that are not "free": they are already a reference to the index. */
const REFERENCE = /^(var\(|\{[^}]+\}$)/;

/**
 * Decide what happens to a value a person typed into a token field.
 *
 * A token id the index has is taken. Anything else is refused — that is the
 * whole point of composing from a reviewed index — and the refusal carries
 * the nearest token so the answer is one press away.
 */
export function refuseFreeValue(value: string, tokens: readonly FlatDesignToken[]): FreeValueRefusal | undefined {
  const wanted = value.trim();
  if (wanted.length === 0) return undefined;
  if (tokens.some((token) => token.path === wanted)) return undefined;
  if (REFERENCE.test(wanted) && tokens.some((token) => wanted.includes(token.property) || wanted.includes(token.path))) return undefined;
  const suggestion = suggestTokenForValue(wanted, tokens);
  const message =
    tokens.length === 0
      ? "This design has no reviewed token document yet, so there is nothing to bind this to. Build the design index first, or keep the value in the brief."
      : `This project's design system has no value like that, and a design composes only from it.${suggestion ? "" : " Pick a token from the list."}`;
  return { message, ...(suggestion ? { suggestion } : {}) };
}

/** A token's value, shortened for a chip without losing what it is. */
export function tokenValueLabel(token: FlatDesignToken): string {
  return token.value.length > 40 ? `${token.value.slice(0, 39)}…` : token.value;
}
