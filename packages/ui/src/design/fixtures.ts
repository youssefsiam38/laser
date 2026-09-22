/**
 * Fixtures: the content a frame shows instead of lorem ipsum (M21-T11).
 *
 * "Lists, text and images bind to fixture data — parsed examples from the
 * index or generated — so screens show realistic content"
 * (`docs/design-phase.md`). A revision names its fixtures and how many rows
 * each has; the rows themselves are a blob, and the surface passes them in
 * when it has read one.
 *
 * When it has not, a fixture is *generated* here, deterministically from its
 * own id, so the same screen shows the same content on every machine and in
 * every screenshot. Generated rows are labelled as generated wherever they are
 * shown: made-up content presented as real data would be a lie about the
 * design's grounding.
 */
import type { DesignBody } from "@lasercode/protocol";

export interface FixtureTable {
  columns: string[];
  rows: string[][];
  /** True when these rows were generated here rather than read from a blob. */
  generated: boolean;
}

export type FixtureData = Readonly<Record<string, FixtureTable>>;

/** A tiny, stable hash so the same id always produces the same content. */
function seed(text: string): () => number {
  let state = 0;
  for (let index = 0; index < text.length; index += 1) state = (state * 31 + text.charCodeAt(index)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const WORDS = ["Billing", "Invoice", "Workspace", "Member", "Project", "Report", "Plan", "Draft", "Review", "Release", "Archive", "Signal"];
const STATES = ["Active", "Paused", "Draft", "Done", "Waiting"];

/** One generated table for a fixture that has no rows on this machine yet. */
export function generateFixture(id: string, name: string, rows: number, columns = 3): FixtureTable {
  const next = seed(`${id}:${name}`);
  const headers = ["Name", "State", "Updated"].slice(0, columns);
  const body: string[][] = [];
  const count = Math.min(Math.max(rows, 1), 12);
  for (let index = 0; index < count; index += 1) {
    const word = WORDS[Math.floor(next() * WORDS.length)] ?? "Item";
    const state = STATES[Math.floor(next() * STATES.length)] ?? "Active";
    const days = Math.floor(next() * 28) + 1;
    body.push([`${word} ${String(index + 1)}`, state, `${String(days)} days ago`].slice(0, columns));
  }
  return { columns: headers, rows: body, generated: true };
}

/** The table a node's fixture prop resolves to: read if we have it, generated if not. */
export function fixtureTable(body: Pick<DesignBody, "fixtures">, fixtureId: string, data: FixtureData | undefined, columns = 3): FixtureTable | undefined {
  const supplied = data?.[fixtureId];
  if (supplied) return supplied;
  const fixture = body.fixtures.find((candidate) => candidate.id === fixtureId);
  if (!fixture) return undefined;
  return generateFixture(fixture.id, fixture.name, fixture.rows, columns);
}

/** The single column a list-shaped primitive (nav, select) wants. */
export function fixtureItems(body: Pick<DesignBody, "fixtures">, fixtureId: string, data: FixtureData | undefined): string[] {
  const table = fixtureTable(body, fixtureId, data, 1);
  return table ? table.rows.map((row) => row[0] ?? "") : [];
}
