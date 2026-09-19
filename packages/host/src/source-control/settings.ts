/**
 * Write the per-project retention file the worker already reads, so a live
 * worker picks the new value up on the next capture without a protocol round-trip.
 */
import {
  PROJECT_DIR_NAME,
  SOURCE_CONTROL_SETTINGS_FILE,
  mergeSourceControlSettingsJson,
  type CheckpointRetention,
} from "@lasercode/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function writeProjectCheckpointRetention(projectCwd: string, retention: CheckpointRetention): void {
  const dir = join(resolve(projectCwd), PROJECT_DIR_NAME);
  const file = join(dir, SOURCE_CONTROL_SETTINGS_FILE);
  mkdirSync(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    existing = {};
  }
  writeFileSync(file, mergeSourceControlSettingsJson(existing, retention));
}
