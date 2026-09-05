/**
 * Project trust, read-only (M2-T4).
 *
 * Pi gates project-local resources (`.pi/settings.json`, `.pi/extensions`,
 * `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`,
 * `.pi/APPEND_SYSTEM.md`, and any `.agents/skills` at or above the directory)
 * behind a trust decision, and asks about it on an interactive start. The SDK
 * does not: `resolveProjectTrusted` is only called by Pi's own `main.ts` and
 * package CLI, and `SettingsManager` defaults `projectTrusted` to **true**, so
 * an SDK host that says nothing silently loads whatever the repository ships.
 *
 * The host therefore decides before it starts a worker, and passes the answer
 * down. This module only reads: Pi's `trust.json` (nearest-ancestor entry wins,
 * exactly as `findNearestTrustEntry` does) and `defaultProjectTrust` from the
 * global settings file. piorbit's own decisions live in the project registry;
 * Pi's trust store has a lock protocol we are not going to reimplement from the
 * outside, and never writing it keeps `docs/architecture.md`'s "data we read"
 * list true.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Entries under `<cwd>/.pi` that make a project trust-requiring (Pi 0.85). */
const TRUST_REQUIRING = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

export type DefaultProjectTrust = "ask" | "always" | "never";

export interface TrustReasons {
  /** Human-readable list of what is trust-gated, for the dialog. */
  reasons: string[];
  required: boolean;
}

/** `~` and relative paths resolved the way Pi resolves them. */
export function canonical(path: string): string {
  const expanded = path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/**
 * What in this directory needs a trust decision. Mirrors Pi's
 * `hasTrustRequiringProjectResources`, but names what it found so the dialog
 * can tell the user why they are being asked.
 */
export function trustReasons(cwd: string): TrustReasons {
  const dir = canonical(cwd);
  const reasons: string[] = [];
  for (const entry of TRUST_REQUIRING) {
    if (existsSync(join(dir, ".pi", entry))) reasons.push(`.pi/${entry}`);
  }
  const userSkills = join(canonical(homedir()), ".agents", "skills");
  let current = dir;
  for (;;) {
    const skills = join(current, ".agents", "skills");
    // The user's own ~/.agents/skills is a user resource, not a project one.
    if (skills !== userSkills && existsSync(skills)) {
      reasons.push(current === dir ? ".agents/skills" : `${skills} (inherited)`);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { reasons, required: reasons.length > 0 };
}

/**
 * Pi's saved decision for this directory or the nearest ancestor that has one.
 * `undefined` = no saved decision anywhere on the path.
 */
export function savedPiTrust(cwd: string, agentDir: string): boolean | undefined {
  const file = join(canonical(agentDir), "trust.json");
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(file, "utf8")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    data = parsed as Record<string, unknown>;
  } catch {
    return undefined; // missing or malformed: treat as "no opinion"
  }
  let current = canonical(cwd);
  for (;;) {
    const value = data[current];
    if (value === true || value === false) return value;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** `defaultProjectTrust` from Pi's global settings (global-only setting). */
export function defaultProjectTrust(agentDir: string): DefaultProjectTrust {
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(join(canonical(agentDir), "settings.json"), "utf8")));
    const value = (parsed as { defaultProjectTrust?: unknown } | null)?.defaultProjectTrust;
    return value === "always" || value === "never" ? value : "ask";
  } catch {
    return "ask";
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
