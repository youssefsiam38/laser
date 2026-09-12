/** Layout direction is an appearance preference, independent of content language. */
export type TextDirection = "system" | "ltr" | "rtl";
export type Direction = "ltr" | "rtl";

const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Syrc", "Thaa", "Nkoo", "Adlm", "Rohg", "Mand", "Samr"]);

export function systemDirection(language = typeof navigator === "undefined" ? "en" : navigator.language): Direction {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & { getTextInfo?: () => { direction: string } };
    // Honour an explicit script (az-Arab, ar-Latn), including on older Chromium.
    if (locale.script) return RTL_SCRIPTS.has(locale.script) ? "rtl" : "ltr";
    const info = locale.getTextInfo?.();
    if (info?.direction === "rtl" || info?.direction === "ltr") return info.direction;
    return RTL_SCRIPTS.has(locale.maximize().script ?? "") ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

export function resolveDirection(preference: TextDirection): Direction {
  return preference === "system" ? systemDirection() : preference;
}

/** Legacy side props name the LTR placement; resolve once at the primitive boundary. */
export function logicalSide<T extends "left" | "right" | "top" | "bottom" | undefined>(side: T, direction: Direction): T {
  return (direction === "rtl" ? side === "left" ? "right" : side === "right" ? "left" : side : side) as T;
}

/** Normalize horizontal navigation only; vertical and editing keys retain their meanings. */
export function logicalArrowKey(key: string, direction: Direction): string {
  return direction === "rtl" ? key === "ArrowLeft" ? "ArrowRight" : key === "ArrowRight" ? "ArrowLeft" : key : key;
}
