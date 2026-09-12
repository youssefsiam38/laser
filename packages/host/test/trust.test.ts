import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustReasons } from "../src/trust.js";

describe("project setup trust", () => {
  let project: string;
  beforeEach(() => { project = mkdtempSync(join(tmpdir(), "setup-trust-")); });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  it("requires a trust decision for a project shipping only the hook", () => {
    expect(trustReasons(project)).toEqual({ required: false, reasons: [] });
    mkdirSync(join(project, PROJECT_DIR_NAME));
    writeFileSync(join(project, PROJECT_DIR_NAME, "worktree-setup"), "#!/bin/sh\nexit 0\n");
    expect(trustReasons(project)).toEqual({ required: true, reasons: [`${PROJECT_DIR_NAME}/worktree-setup`] });
  });

  it("retains settings as a separate reason", () => {
    mkdirSync(join(project, PROJECT_DIR_NAME));
    for (const file of ["settings.json", "worktree-setup"]) writeFileSync(join(project, PROJECT_DIR_NAME, file), "");
    expect(trustReasons(project)).toEqual({ required: true, reasons: [`${PROJECT_DIR_NAME}/settings.json`, `${PROJECT_DIR_NAME}/worktree-setup`] });
  });
});
