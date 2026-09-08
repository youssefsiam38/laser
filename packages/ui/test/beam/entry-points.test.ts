/**
 * Beam has exactly one entry point (docs/agents.md "Beam"): the spark beside
 * Settings, rendered by the rail and, on a phone, by the sessions sheet's
 * footer. Nothing else creates a Beam session or opens the bubble — no menu
 * item, no palette command, no empty-state link. A grep is the cheapest guard
 * against a second door appearing.
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

describe("Beam's one entry point", () => {
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

  it("creates Beam sessions from the bubble alone", () => {
    // The agent name is spelled once, in Beam's own model; every other file
    // that could start a session with it would be a second entry point.
    const creators = sources.filter(({ name, text }) => !name.startsWith("components/beam/") && /agentName:\s*["']beam["']|BEAM_AGENT_NAME|beamWorkspace\(/.test(text));
    expect(creators.map(({ name }) => name)).toEqual([]);
  });

  it("offers no Beam command in the palette and no Beam link in the project empty state", () => {
    const palette = sources.find(({ name }) => name === "components/shell/CommandPalette.tsx")!.text;
    const empty = sources.find(({ name }) => name === "components/thread/EmptyState.tsx")!.text;
    expect(palette).not.toMatch(/\bBeam\b/);
    expect(empty).not.toMatch(/\bBeam\b/);
  });
});
