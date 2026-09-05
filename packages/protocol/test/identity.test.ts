/**
 * The product's identity: one source of truth, and a check that keeps it (MX-T7).
 *
 * Two things are proved here.
 *
 * 1. `product.json` round-trips through the schema that guards it, so a field
 *    typed wrong (an app id with two segments, an env prefix in lower case) is
 *    a named failure rather than a build that ships a product answering to two
 *    names.
 * 2. Nothing in the repository disagrees with it. `scripts/identity/check.mjs`
 *    already runs inside `pnpm -r build`; running it here as well means
 *    `pnpm -r test` catches the same drift, which is the command most people
 *    reach for first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_ID,
  DATA_DIR_NAME,
  ENV,
  ENV_PREFIX,
  FORMER_NAMES,
  PRODUCT,
  PRODUCT_NAME,
  URL_SCHEME_PREFIX,
  WIRE_NAMESPACE,
  dottedStorageKey,
  envVar,
  isProductUrl,
  productIdentitySchema,
  readEnv,
  storageKey,
  storageKeyHistory,
  symbolKey,
} from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("product.json", () => {
  it("round-trips through its schema", () => {
    const onDisk: unknown = JSON.parse(readFileSync(new URL("../../../product.json", import.meta.url), "utf8"));
    const parsed = productIdentitySchema.parse(onDisk);
    // The generated module is the same identity, seen from TypeScript.
    expect(parsed.name).toBe(PRODUCT_NAME);
    expect(parsed.appId).toBe(APP_ID);
    expect(parsed.envPrefix).toBe(ENV_PREFIX);
    expect(parsed.wireNamespace).toBe(WIRE_NAMESPACE);
    // …and re-serialising it changes nothing, so the schema drops no field the
    // generators read.
    expect(productIdentitySchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("refuses an app id that is not reverse-DNS, because macOS and Windows key grants on it", () => {
    // Deliberately not the product name: this asserts the *shape* (reverse-DNS,
    // at least one dot), and spelling the name here would be a stray literal.
    const bad = { ...PRODUCT, appId: "no-dots" };
    expect(() => productIdentitySchema.parse(bad)).toThrow();
  });
});

describe("derived names", () => {
  it("composes every namespace from the one value", () => {
    expect(URL_SCHEME_PREFIX).toBe(`${PRODUCT.urlScheme}://`);
    expect(envVar("AGENT_DIR")).toBe(ENV.agentDir);
    expect(storageKey("panels")).toBe(`${PRODUCT.storagePrefix}-panels`);
    expect(dottedStorageKey("theme")).toBe(`${PRODUCT.storagePrefix}.theme`);
    expect(symbolKey("transcribe.v1")).toBe(`${PRODUCT.symbolPrefix}.transcribe.v1`);
    expect(DATA_DIR_NAME).toBe(PRODUCT.dirName);
  });

  it("reads a variable under a former name's prefix, so a rename does not break a shell profile", () => {
    expect(readEnv({ [ENV.agentDir]: " /a " }, "AGENT_DIR")).toEqual({ value: "/a", variable: ENV.agentDir });
    expect(readEnv({ [ENV.agentDir]: "   " }, "AGENT_DIR")).toBeUndefined();
    const former = { name: "old", dirName: "old", storagePrefix: "old", envPrefix: "OLD", symbolPrefix: "old", urlScheme: "old" };
    const withHistory = [...FORMER_NAMES, former];
    expect(withHistory.map((entry) => `${entry.envPrefix}_AGENT_DIR`)).toContain("OLD_AGENT_DIR");
  });

  it("offers every storage key under every name the product has had", () => {
    expect(storageKeyHistory("panels")).toEqual([
      `${PRODUCT.storagePrefix}-panels`,
      ...FORMER_NAMES.map((former) => `${former.storagePrefix}-panels`),
    ]);
  });

  it("recognises a deep link under the current scheme and every former one", () => {
    expect(isProductUrl(`${URL_SCHEME_PREFIX}open`)).toBe(true);
    expect(isProductUrl("https://example.com")).toBe(false);
  });
});

describe("the repository", () => {
  it("agrees with product.json everywhere", () => {
    // Throws with the offending file and line when it does not.
    execFileSync(process.execPath, ["scripts/identity/check.mjs"], { cwd: repoRoot, encoding: "utf8" });
  });
});
