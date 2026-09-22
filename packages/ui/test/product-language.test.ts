/**
 * The product's words, guarded (M21-T23).
 *
 * `docs/project-lifecycle-leap.md` ("Outside the workspace") settles two nouns
 * that used to be one: **Command** is the long-running command an agent left
 * going, and **Task** is the project's own kind (`TASK-44`). A person reads
 * "Command"; the identifiers, the protocol method names (`tasks/list`,
 * `tasks/stop`), the store and the tests keep `task`, because renaming a wire
 * method to fix a noun is how a release breaks.
 *
 * So this walks the app's own sources, throws away the comments — a comment is
 * not a surface — and fails on the retired phrases wherever they could still
 * be drawn. It is the copy check M17-T18 established for "harness" and
 * "subagents", applied to the one word M21 gave a second meaning.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);

/** Retired on every surface a person reads. The replacement is in the message. */
const RETIRED: ReadonlyArray<{ phrase: RegExp; instead: string }> = [
  { phrase: /background tasks?/i, instead: '"Command" (or "commands", lower case, in a sentence about shell commands)' },
  { phrase: /background commands?/i, instead: '"Command" — the fleet row\'s own noun' },
];

/**
 * Comments are not copy. Block comments, line comments and the doc block at
 * the top of a file may say "background task" as often as the history needs;
 * only what can reach the screen is checked.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sources(dir: URL, prefix = ""): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    out.push({ name: `${prefix}${entry.name}`, text: readFileSync(new URL(entry.name, dir), "utf8") });
  }
  return out;
}

describe("the words a person reads", () => {
  it("never calls a Command a background task", () => {
    const offenders: string[] = [];
    for (const { name, text } of sources(SRC)) {
      const code = withoutComments(text);
      for (const { phrase, instead } of RETIRED) {
        const hit = phrase.exec(code);
        if (hit) offenders.push(`${name}: “${hit[0]}” — say ${instead}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Task for the project's own kind, never for an agent's brief", () => {
    const fleet = readFileSync(new URL("components/fleet/FleetPanel.tsx", SRC), "utf8");
    const map = readFileSync(new URL("components/agents/map/Inspector.tsx", SRC), "utf8");
    expect(withoutComments(fleet)).toContain('<Field label="Brief">');
    expect(withoutComments(fleet)).not.toContain('<Field label="Task">');
    expect(withoutComments(map)).toContain('<h4 className="eyebrow">Brief</h4>');
  });
});
