import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyReviewedInstallScripts } from "../src/packages.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "package-policy-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reviewed extension install scripts", () => {
  it("pins only the reviewed scripts for pi-subagents 0.65.1", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");

    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:pi-subagents@0.65.1")).toBe(true);

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
    applyReviewedInstallScripts(root, agentDir, "user", "npm:pi-subagents@0.65.1");
    const path = join(npmDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest["allowScripts"] = { esbuild: false };
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:pi-subagents@0.65.1")).toBe(true);
    expect(applyReviewedInstallScripts(root, agentDir, "user", "npm:pi-subagents@0.65.2")).toBe(false);
    const final = JSON.parse(readFileSync(path, "utf8")) as { allowScripts: Record<string, boolean> };
    expect(final.allowScripts).toEqual({
      esbuild: false,
      "@google/genai@1.52.0": true,
      "protobufjs@7.6.6": true,
    });
  });
});
