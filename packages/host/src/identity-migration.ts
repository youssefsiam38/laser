/**
 * What happens to a person's data when the product is renamed (MX-T7, D-36).
 *
 * "laser" is a working name. Everything the product owns on disk is named
 * after it — `~/.local/share/<name>` and the platform equivalents,
 * `~/.config/<name>`, the legacy `~/.<name>` — so a rename would leave an
 * installed copy looking at an empty directory beside a full one, with the
 * person's sessions, settings, credentials, paired devices and theme in the
 * one it no longer opens. Nothing would break loudly. It would just look like
 * the app forgot them.
 *
 * So on start, before anything reads or writes, this runs: for each directory
 * the product owns, if a former name's directory exists and the current one
 * does not, it is moved and the move is reported once. It is deliberately
 * conservative:
 *
 * - **It never merges.** If both exist, the current one wins and the old one is
 *   left exactly as it is. Merging two settings files or two session
 *   directories is a decision only the person can make, and silently picking
 *   one is how someone loses work.
 * - **It never deletes.** A failed move leaves both directories intact.
 * - **It renames rather than copies.** A rename inside one filesystem is
 *   atomic and instant; across filesystems (a bind-mounted `~/.config`) it
 *   falls back to a copy into a sibling directory this process owns, which is
 *   then renamed into place, so an interrupted copy leaves neither a
 *   half-migrated tree the app would open nor a directory another process is
 *   writing into.
 * - **An empty destination is not a destination.** A directory that exists but
 *   holds nothing was made by something asking whether it could write there —
 *   `doctor` does exactly this — and treating it as a real install would
 *   orphan a person's sessions, credentials and paired devices permanently, on
 *   the one command they run when an upgrade looks wrong.
 * - **It says what it did**, once, in the host log — because a directory
 *   moving under a person is exactly the sort of thing they should be able to
 *   find an explanation for.
 *
 * `FORMER_NAMES` in product.json drives it. With no former names it does
 * nothing at all, which is today's answer.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR_NAME, FORMER_NAMES, PRODUCT_NAME } from "@lasercode/protocol";

/** One directory that moved, or refused to. */
export interface IdentityMigrationStep {
  from: string;
  to: string;
  outcome: "moved" | "copied" | "kept-both" | "failed";
  /** Set for "kept-both" and "failed": what a person should know. */
  reason?: string;
}

export interface IdentityMigrationResult {
  steps: IdentityMigrationStep[];
  /** One line per step, ready for the host log. Empty when nothing happened. */
  lines: string[];
}

/**
 * Every directory the product owns, for one name, on this platform.
 *
 * `~/.config/<name>` is included on every platform even though only Linux uses
 * XDG by convention: `install.sh --purge` removes it there, and a person who
 * moved a home directory between machines can have one anywhere.
 */
export function ownedDirectories(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env["HOME"] ?? homedir();
  const dirs: string[] = [];

  if (process.platform === "darwin") {
    dirs.push(join(home, "Library", "Application Support", name));
  } else if (process.platform === "win32") {
    const base = env["LOCALAPPDATA"] ?? env["APPDATA"] ?? join(home, "AppData", "Local");
    dirs.push(join(base, name));
  } else {
    const xdgData = env["XDG_DATA_HOME"];
    dirs.push(xdgData && xdgData.trim() !== "" ? join(xdgData, name) : join(home, ".local", "share", name));
  }

  const xdgConfig = env["XDG_CONFIG_HOME"];
  dirs.push(xdgConfig && xdgConfig.trim() !== "" ? join(xdgConfig, name) : join(home, ".config", name));
  dirs.push(join(home, `.${name}`));
  return dirs;
}

function moveOne(from: string, to: string): IdentityMigrationStep {
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return { from, to, outcome: "moved" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      return {
        from,
        to,
        outcome: "failed",
        reason: `it could not be moved (${error instanceof Error ? error.message : String(error)}). Nothing was deleted.`,
      };
    }
    // Different filesystems. Copy into a sibling this process owns, rename that
    // into place, and only then remove the original — so a crash mid-copy
    // leaves the original whole and leaves nothing at `to` for the next start
    // to mistake for a finished migration. Nothing here ever removes a path
    // this process did not create: two copies racing must not be able to delete
    // each other's work, or the person's.
    const staging = `${to}.incoming-${process.pid}`;
    try {
      rmSync(staging, { recursive: true, force: true });
      cpSync(from, staging, { recursive: true, errorOnExist: true, force: false });
      renameSync(staging, to);
      rmSync(from, { recursive: true, force: true });
      return { from, to, outcome: "copied" };
    } catch (error2) {
      rmSync(staging, { recursive: true, force: true });
      return {
        from,
        to,
        outcome: "failed",
        reason: `it is on another filesystem and the copy did not finish (${
          error2 instanceof Error ? error2.message : String(error2)
        }). The original is untouched.`,
      };
    }
  }
}

/**
 * Is there really something at `to`, or only a directory somebody made?
 *
 * `doctor` checks that the state directory is writable by creating it. One run
 * of it before the app's first start would otherwise make the migration report
 * "both exist" forever: signed out, no sessions, every paired phone orphaned,
 * and a log line that reads like a deliberate refusal about two installs the
 * person does not have.
 */
function occupied(to: string): boolean {
  if (!existsSync(to)) return false;
  try {
    if (readdirSync(to).length > 0) return true;
    rmdirSync(to); // empty, and now out of the way
    return false;
  } catch {
    // Not a directory, or not readable: leave it alone and keep both.
    return true;
  }
}

/**
 * Move every directory a former name owns onto the current name.
 *
 * Safe to call on every start: with no former names, or with nothing left under
 * one, it returns an empty result and touches nothing.
 *
 * `formerNames` is a parameter only so a test can exercise the move while the
 * real list is empty; every caller passes the real one by leaving it out.
 */
export function migrateFormerIdentities(
  env: NodeJS.ProcessEnv = process.env,
  formerNames: readonly { dirName: string }[] = FORMER_NAMES,
): IdentityMigrationResult {
  const steps: IdentityMigrationStep[] = [];
  if (formerNames.length === 0) return { steps, lines: [] };

  const current = ownedDirectories(DATA_DIR_NAME, env);
  for (const former of formerNames) {
    const old = ownedDirectories(former.dirName, env);
    for (const [index, from] of old.entries()) {
      const to = current[index];
      if (to === undefined || from === to) continue;
      let fromIsDirectory = false;
      try {
        fromIsDirectory = statSync(from).isDirectory();
      } catch {
        continue; // nothing there
      }
      if (!fromIsDirectory) continue;
      if (occupied(to)) {
        steps.push({
          from,
          to,
          outcome: "kept-both",
          reason: `${to} already exists, so nothing was moved. Merging two of these is a decision only you can make.`,
        });
        continue;
      }
      steps.push(moveOne(from, to));
    }
  }

  const lines = steps.map((step) => {
    if (step.outcome === "moved" || step.outcome === "copied") {
      return `${PRODUCT_NAME}: moved your data from ${step.from} to ${step.to} — this product was renamed, and your sessions, settings and paired devices came with it.`;
    }
    return `${PRODUCT_NAME}: ${step.from} is from an earlier name of this product, and ${step.reason}`;
  });
  return { steps, lines };
}
