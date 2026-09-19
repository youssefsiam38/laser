/**
 * Per-project checkpoint retention, stored beside other project files under
 * `<cwd>/.…/source-control.json`. The Settings control is owned by another
 * milestone; this module is the storage and the default.
 */
import { CHECKPOINT_RETENTION_DEFAULT, PROJECT_DIR_NAME, isCheckpointRetention, type CheckpointRetention } from "@lasercode/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FILE = "source-control.json";

export function sourceControlSettingsPath(projectCwd: string): string {
  return join(resolve(projectCwd), PROJECT_DIR_NAME, FILE);
}

export function readCheckpointRetention(projectCwd: string): CheckpointRetention {
  try {
    const parsed = JSON.parse(readFileSync(sourceControlSettingsPath(projectCwd), "utf8")) as { checkpointRetention?: unknown };
    if (isCheckpointRetention(parsed.checkpointRetention)) return parsed.checkpointRetention;
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
  writeFileSync(file, `${JSON.stringify({ ...existing, checkpointRetention: retention }, null, 2)}\n`);
}
