/** Product-owned project trust for project configuration. */
import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const TRUST_REQUIRING = ["settings.json", "worktree-setup"] as const;

export interface TrustReasons {
  /** Human-readable list of what is trust-gated, for the dialog. */
  reasons: string[];
  required: boolean;
}

/** Expand `~` and make paths absolute before using them as registry keys. */
export function canonical(path: string): string {
  const expanded = path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/**
 * What product-owned data in this directory needs a trust decision.
 */
export function trustReasons(cwd: string): TrustReasons {
  const dir = canonical(cwd);
  const reasons: string[] = [];
  for (const entry of TRUST_REQUIRING) {
    if (existsSync(join(dir, PROJECT_DIR_NAME, entry))) reasons.push(`${PROJECT_DIR_NAME}/${entry}`);
  }
  return { reasons, required: reasons.length > 0 };
}
