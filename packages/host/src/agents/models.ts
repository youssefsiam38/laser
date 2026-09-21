/**
 * The model the product proposes on a person's behalf.
 *
 * The rule itself lives in the protocol now (`suggestBalancedModel`), because
 * the seeds, the migration and onboarding all have to agree about it
 * (`docs/model-profiles.md`). This module keeps the host-facing name so the
 * callers that only want one model do not have to know about profiles.
 */
import { suggestBalancedModel, type ModelCatalogEntry, type ModelIdentity } from "@lasercode/protocol";

export interface SuggestModelOptions {
  /**
   * Providers a credential is configured for. When given, only their models
   * qualify: the catalogue lists every model the engine knows, including ones
   * nobody has signed in to.
   */
  configuredProviders?: ReadonlySet<string>;
}

/** The model a balanced, everyday profile should prefer. */
export function suggestEverydayModel(entries: readonly ModelCatalogEntry[], options: SuggestModelOptions = {}): ModelIdentity | null {
  return suggestBalancedModel(entries, { ...(options.configuredProviders ? { configuredProviders: options.configuredProviders } : {}) });
}
