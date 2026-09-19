import { PRODUCT_NAME } from "@lasercode/protocol";

export type DiffStylePref = "split" | "unified";

const KEY = `${PRODUCT_NAME}.changes-diff-style`;

function readStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Split is the default (D-315). Remembered per person, not per file. */
export function readDiffStylePref(): DiffStylePref {
  const raw = readStore()?.getItem(KEY);
  return raw === "unified" ? "unified" : "split";
}

export function writeDiffStylePref(style: DiffStylePref): void {
  try {
    readStore()?.setItem(KEY, style);
  } catch {
    // A browser that refuses site data keeps the in-memory choice only.
  }
}
