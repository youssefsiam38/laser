import { PRODUCT_DISPLAY_NAME, type FeatureState } from "@lasercode/protocol";

import type { SettingsScopeView } from "@/runtime/settings-scope";

/** The choice shown by every scoped surface for this feature. */
export function selectedFeatureValue(feature: FeatureState, view: SettingsScopeView): boolean {
  if (view === "global") return feature.globalEnabled;
  if (view === "project") return feature.projectEnabled ?? feature.globalEnabled;
  return feature.enabled;
}

/** One scope vocabulary and provenance model for every feature surface. */
export function featureSource(feature: FeatureState, view: SettingsScopeView): string {
  if (view === "global") {
    return feature.globalSource === "default" ? `${PRODUCT_DISPLAY_NAME} default` : "Your Global choice";
  }
  if (view === "project") {
    return feature.projectEnabled !== undefined ? "Overridden for this project" : "Follows Global choice";
  }
  if (feature.source === "project") return "Effective choice · Project override";
  if (feature.source === "global") return "Effective choice · Global choice";
  return `Effective choice · ${PRODUCT_DISPLAY_NAME} default`;
}
