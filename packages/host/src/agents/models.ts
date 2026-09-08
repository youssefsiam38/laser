/**
 * Model choices the product makes on a person's behalf, as pure functions over
 * the engine's catalogue so they can be tested without a provider.
 *
 * Beam wants an "average but fast" model (the original request names a
 * gpt-5.x-luna class model as today's standard): smart enough to read a data
 * directory and explain it, cheap enough to be opened casually. The suggestion
 * is offered in the choose-model dialog, never applied silently.
 */
import type { AgentModelChoice, ModelCatalogEntry } from "@lasercode/protocol";

/** Model ids that name the fast tier of their family. `gpt-5*` counts unless it is a `pro` variant. */
const FAST_TIER = /luna|sonnet|flash|mini|o4-mini|gpt-5(?!.*pro)/i;

/** Combined list price (input + output, per million tokens) of the mid-to-low band. */
const BAND_MIN = 0.2;
const BAND_MAX = 6;

export interface SuggestBeamModelOptions {
  /**
   * Providers a credential is configured for. When given, only their models
   * qualify: the catalogue lists every model the engine knows, including ones
   * nobody has signed in to.
   */
  configuredProviders?: ReadonlySet<string>;
}

function combinedCost(entry: ModelCatalogEntry): number | undefined {
  const input = entry.cost?.input;
  const output = entry.cost?.output;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return input + output;
}

const byName = (a: ModelCatalogEntry, b: ModelCatalogEntry) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);

/**
 * The model Beam should propose: a fast-tier model in the mid-to-low price
 * band (the priciest of them, so the smartest of the fast tier), else the
 * median-priced usable model, else null when nothing is usable.
 */
export function suggestBeamModel(entries: readonly ModelCatalogEntry[], options: SuggestBeamModelOptions = {}): AgentModelChoice | null {
  const usable = entries.filter(
    (entry) => entry.enabled && (options.configuredProviders === undefined || options.configuredProviders.has(entry.provider)),
  );
  if (usable.length === 0) return null;

  const priced = usable
    .map((entry) => ({ entry, cost: combinedCost(entry) }))
    .filter((item): item is { entry: ModelCatalogEntry; cost: number } => item.cost !== undefined)
    .sort((a, b) => a.cost - b.cost || byName(a.entry, b.entry));

  const fast = priced.filter(({ entry, cost }) => FAST_TIER.test(entry.id) && cost >= BAND_MIN && cost <= BAND_MAX);
  const pick = fast.length > 0 ? fast[fast.length - 1]!.entry : priced.length > 0 ? priced[Math.floor((priced.length - 1) / 2)]!.entry : [...usable].sort(byName)[0]!;
  return { provider: pick.provider, id: pick.id };
}
