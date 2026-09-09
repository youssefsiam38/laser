import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyReviewedInstallScripts, type ReviewedInstallScripts } from "../src/packages.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "package-policy-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for a reviewed release. The shipped table is empty since D-140
 * took delegation in-house, so the mechanism is exercised against a fixture
 * rather than a package Laser offers.
 */
const REVIEWED: ReviewedInstallScripts = {
  "npm:example-extension@1.2.3": {
    "esbuild@0.28.1": true,
    "@google/genai@1.52.0": true,
    "protobufjs@7.6.6": true,
  },
};

describe("reviewed extension install scripts", () => {
  it("pins only the scripts reviewed for that exact release", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");

    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:example-extension@1.2.3", REVIEWED)).toBe(true);

    const manifest = JSON.parse(readFileSync(join(agentDir, "npm", "package.json"), "utf8")) as {
      allowScripts: Record<string, boolean>;
    };
    expect(manifest.allowScripts).toEqual({
      "esbuild@0.28.1": true,
      "@google/genai@1.52.0": true,
      "protobufjs@7.6.6": true,
    });
  });

  it("does not inherit approvals to another release or override an explicit denial", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const npmDir = join(agentDir, "npm");
    applyReviewedInstallScripts(root, agentDir, "user", "npm:example-extension@1.2.3", REVIEWED);
    const path = join(npmDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest["allowScripts"] = { esbuild: false };
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:example-extension@1.2.3", REVIEWED)).toBe(true);
    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:example-extension@1.2.4", REVIEWED)).toBe(false);
    const final = JSON.parse(readFileSync(path, "utf8")) as { allowScripts: Record<string, boolean> };
    expect(final.allowScripts).toEqual({
      esbuild: false,
      "@google/genai@1.52.0": true,
      "protobufjs@7.6.6": true,
    });
  });

  /**
   * The new truth after D-140/M13-T11: `pi-subagents` is neither bundled nor
   * offered, so nothing inherits its old approvals. An install of it — or of
   * anything else — fails closed until a release is reviewed and listed.
   */
  it("ships no standing approvals, so an unreviewed source writes nothing", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");

    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:pi-subagents@0.65.1")).toBe(false);
    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:anything@1.0.0")).toBe(false);
    expect(() => readFileSync(join(agentDir, "npm", "package.json"), "utf8")).toThrow();
  });
});
