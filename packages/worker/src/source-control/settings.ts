/**
 * Per-project checkpoint retention, stored beside other project files under
 * `<cwd>/<PROJECT_DIR_NAME>/source-control.json`.
 */
import {
  CHECKPOINT_RETENTION_DEFAULT,
  PROJECT_DIR_NAME,
  SOURCE_CONTROL_SETTINGS_FILE,
  checkpointRetentionFromSettingsJson,
  mergeSourceControlSettingsJson,
  type CheckpointRetention,
} from "@lasercode/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function sourceControlSettingsPath(projectCwd: string): string {
  return join(resolve(projectCwd), PROJECT_DIR_NAME, SOURCE_CONTROL_SETTINGS_FILE);
}

export function readCheckpointRetention(projectCwd: string): CheckpointRetention {
  try {
    const parsed = checkpointRetentionFromSettingsJson(readFileSync(sourceControlSettingsPath(projectCwd), "utf8"));
    if (parsed) return parsed;
  } catch {
    // Absent or unreadable: the default stands.
  }
  return CHECKPOINT_RETENTION_DEFAULT;
}

export function writeCheckpointRetention(projectCwd: string, retention: CheckpointRetention): void {
  const file = sourceControlSettingsPath(projectCwd);
  mkdirSync(join(resolve(projectCwd), PROJECT_DIR_NAME), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    existing = {};
  }
  writeFileSync(file, mergeSourceControlSettingsJson(existing, retention));
}
