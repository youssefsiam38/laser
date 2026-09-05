/**
 * AGENTS.md invariant 7: the relay links no crypto library and never parses
 * payloads beyond the channel id. That is a property of the dependency graph, so
 * assert it on the dependency graph rather than trusting a code review.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const sources = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(`${srcDir}/${name}`, "utf8") }));

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  dependencies?: Record<string, string>;
};

/** Anything that could decrypt, sign, or hold key material. */
const FORBIDDEN = [/@lasercode\/crypto/, /@noble\//, /tweetnacl/, /libsodium/, /sodium-native/, /noise-/, /jose/, /openpgp/];

describe("relay purity", () => {
  it("declares no crypto dependency", () => {
    for (const name of Object.keys(packageJson.dependencies ?? {})) {
      for (const pattern of FORBIDDEN) expect(name, `dependency ${name}`).not.toMatch(pattern);
    }
    // `ws` and nothing but the product's own identity. `@lasercode/protocol` is
    // reached only through its `/identity` subpath — a dependency-free module of
    // strings (MX-T7), so the relay still links no schema, no validator and no
    // crypto, and the one thing it prints keeps the product's name after a
    // rename instead of an old one.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(["@lasercode/protocol", "ws"]);
    const identityOnly = sources.every(({ text }) => !/from "@lasercode\/protocol"/.test(text));
    expect(identityOnly, "the relay imports @lasercode/protocol's identity subpath only").toBe(true);
  });

  it("imports no crypto library", () => {
    // Match module specifiers only: prose may name @lasercode/crypto (protocol.ts
    // explains which of its constants it mirrors) without importing it.
    const specifier = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"|\bimport\("([^"]+)"\)|\brequire\("([^"]+)"\)/g;
    for (const { name, text } of sources) {
      for (const match of text.matchAll(specifier)) {
        const module = match[1] ?? match[2] ?? match[3] ?? "";
        for (const pattern of FORBIDDEN) expect(module, `${name} imports ${module}`).not.toMatch(pattern);
      }
    }
  });

  it("uses node:crypto only for the DoS cookie, never on channel traffic", () => {
    const users = sources.filter(({ text }) => text.includes("node:crypto")).map(({ name }) => name);
    // The cookie is an HMAC over a source IP under a secret the relay rotates
    // itself. It touches no channel and decrypts nothing.
    expect(users).toEqual(["cookie.ts"]);
  });

  it("never decodes a binary frame", () => {
    const server = sources.find(({ name }) => name === "server.ts")!.text;
    // Binary frames may be measured and forwarded. They must never be turned
    // into text or JSON: `toString`/`JSON.parse` appear only on the control path.
    const forwardBlock = server.slice(server.indexOf("private onMessage"), server.indexOf("private onControl"));
    expect(forwardBlock).not.toMatch(/JSON\.parse/);
    expect(forwardBlock).not.toMatch(/toString\(/);
  });
});
