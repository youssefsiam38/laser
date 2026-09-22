/**
 * The project's own instructions, for the implementation context packet.
 *
 * A project's configuration lives in `<project>/<PROJECT_DIR_NAME>` (AGENTS.md
 * invariant 6), so that is where a person's project instructions live:
 * `<PROJECT_DIR_NAME>/instructions.md`. They are read fresh, bounded, and
 * treated as text — never executed, never interpreted, and labelled
 * `[from project instructions]` wherever they are quoted.
 *
 * A project without the file simply has none. The engine's own `AGENTS.md`
 * handling is not touched here: that is Pi's, it already reaches the model,
 * and duplicating it into the packet would spend context twice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_DIR_NAME } from "@lasercode/protocol";

/** The most of a project's instructions the packet will ever carry. */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 8_192;

export function projectInstructionsPath(projectCwd: string): string {
  return join(projectCwd, PROJECT_DIR_NAME, "instructions.md");
}

export function projectInstructions(projectCwd: string): string | undefined {
  try {
    const text = readFileSync(projectInstructionsPath(projectCwd), "utf8");
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    return trimmed.length > PROJECT_INSTRUCTIONS_MAX_BYTES ? `${trimmed.slice(0, PROJECT_INSTRUCTIONS_MAX_BYTES)}…` : trimmed;
  } catch {
    return undefined;
  }
}
