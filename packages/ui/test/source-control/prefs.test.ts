// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { readDiffStylePref, writeDiffStylePref } from "../../src/source-control/prefs.js";

const KEY = `${PRODUCT_NAME}.changes-diff-style`;

afterEach(() => {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
});

it("defaults to split and remembers the person's choice", () => {
  expect(readDiffStylePref()).toBe("split");
  writeDiffStylePref("unified");
  expect(readDiffStylePref()).toBe("unified");
  writeDiffStylePref("split");
  expect(readDiffStylePref()).toBe("split");
});

it("treats an unknown stored value as split", () => {
  globalThis.localStorage?.setItem(KEY, "stacked");
  expect(readDiffStylePref()).toBe("split");
});
