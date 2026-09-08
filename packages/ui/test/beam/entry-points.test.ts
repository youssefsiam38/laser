/**
 * Beam has two ways in, and no more (D-143): the spark beside Settings, which
 * is the only thing that opens the bubble, and the Beam group in the sessions
 * sidebar, whose `+` starts a chat in the window. Nothing else creates a Beam
 * session — no menu item, no palette command, no empty-state link — and the
 * agent's own name is still spelled in one place. A grep is the cheapest
 * guard against a third door appearing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src/", import.meta.url);

function sourceFiles(dir: URL, prefix = ""): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    out.push({ name: `${prefix}${entry.name}`, text: readFileSync(new URL(entry.name, dir), "utf8") });
  }
  return out;
}

const sources = sourceFiles(SRC);
const count = (text: string, needle: RegExp): number => (text.match(needle) ?? []).length;

describe("Beam's ways in", () => {
  it("renders the spark once in the rail and once in the sheet footer, nowhere else", () => {
    const users = sources.filter(({ text }) => /<BeamSpark\b/.test(text)).map(({ name, text }) => [name, count(text, /<BeamSpark\b/g)] as const);
    expect(users).toEqual([
      ["components/shell/Rail.tsx", 1],
      ["components/shell/SessionsPanel.tsx", 1],
    ]);
    // The rail's spark is the last item of the bottom cluster, below Settings.
    const rail = sources.find(({ name }) => name === "components/shell/Rail.tsx")!.text;
    expect(rail.indexOf("<BeamSpark")).toBeGreaterThan(rail.indexOf('tooltip="Settings"'));
    // The sheet footer's spark sits in the footer, beside Settings.
    const panel = sources.find(({ name }) => name === "components/shell/SessionsPanel.tsx")!.text;
    const footer = panel.slice(panel.indexOf("function SheetFooter"));
    expect(footer).toContain("<BeamSpark");
    expect(footer.indexOf("<BeamSpark")).toBeGreaterThan(footer.indexOf('tooltip="Settings"'));
  });

  it("opens the bubble only from the spark, and mounts it once", () => {
    const openers = sources.filter(({ name, text }) => !name.startsWith("components/beam/") && /beamStore\.(open|toggle)\(/.test(text));
    expect(openers.map(({ name }) => name)).toEqual([]);
    const mounts = sources.filter(({ text }) => /<BeamBubble\b/.test(text)).map(({ name, text }) => [name, count(text, /<BeamBubble\b/g)] as const);
    expect(mounts).toEqual([["components/shell/Shell.tsx", 1]]);
  });

  it("creates Beam sessions from the bubble and the sidebar's Beam group, and nowhere else", () => {
    // The agent name and its workspace are spelled once, in Beam's own model.
    // Anywhere else naming them would be starting Beam behind its own back.
    const creators = sources.filter(({ name, text }) => !name.startsWith("components/beam/") && /agentName:\s*["']beam["']|BEAM_AGENT_NAME|beamWorkspace\(/.test(text));
    expect(creators.map(({ name }) => name)).toEqual([]);
    // One caller of the helper, in the sessions panel: the Beam group's `+`.
    const starters = sources.filter(({ name, text }) => !name.startsWith("components/beam/") && /\bstartBeamSession\(/.test(text));
    expect(starters.map(({ name }) => name)).toEqual(["components/shell/SessionsPanel.tsx"]);
  });

  it("offers no Beam command in the palette and no Beam link in the project empty state", () => {
    const palette = sources.find(({ name }) => name === "components/shell/CommandPalette.tsx")!.text;
    const empty = sources.find(({ name }) => name === "components/thread/EmptyState.tsx")!.text;
    expect(palette).not.toMatch(/\bBeam\b/);
    expect(empty).not.toMatch(/\bBeam\b/);
  });
});
