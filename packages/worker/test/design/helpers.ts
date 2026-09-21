/**
 * Shared scaffolding for the Design Index tests.
 *
 * Every test works on a **copy** of a fixture in a temporary directory: a
 * build writes `.<product>/design/index.json` into the project it indexes, and
 * a test must never write into the repository's own fixtures.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignIndex, DesignIndexEntry } from "@lasercode/protocol";
import { buildDesignIndex, type DesignBuildOptions, type DesignBuildResult } from "../../src/design/index/command.js";

export const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures", "design");

export const DESIGN_FIXTURES = ["react-tailwind", "vue-scss", "rails-templates", "monorepo-eras", "dtcg-tokens"] as const;
export type DesignFixture = (typeof DESIGN_FIXTURES)[number];

const created: string[] = [];

/** A writable copy of one fixture project. Removed by `cleanupFixtures()`. */
export function copyFixture(name: DesignFixture): string {
  const directory = mkdtempSync(join(tmpdir(), `design-index-${name}-`));
  cpSync(join(FIXTURE_ROOT, name), directory, { recursive: true });
  created.push(directory);
  return directory;
}

export function cleanupFixtures(): void {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

/** Build one fixture, with `write` on by default so storage is exercised too. */
export async function buildFixture(name: DesignFixture, options: Partial<DesignBuildOptions> = {}): Promise<DesignBuildResult & { projectCwd: string }> {
  const projectCwd = options.projectCwd ?? copyFixture(name);
  const result = await buildDesignIndex({ ...options, projectCwd });
  return { ...result, projectCwd };
}

export function entriesOf(index: DesignIndex, kind: DesignIndexEntry["kind"]): DesignIndexEntry[] {
  return index.entries.filter((entry) => entry.kind === kind);
}

export function entryNamed(index: DesignIndex, kind: DesignIndexEntry["kind"], name: string): DesignIndexEntry | undefined {
  return index.entries.find((entry) => entry.kind === kind && entry.name === name);
}
