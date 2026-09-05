import { describe, expect, it } from "vitest";
import type { PanelIntent, PanelKind } from "@lasercode/protocol";

import { isIsland, placePanel, placementOf, wantsInspectSheet, type Placement } from "../../src/panels/placement.js";

const intents: PanelIntent[] = ["glance", "inline", "follow", "inspect"];

/** The table from docs/ux-panels.md, row by row. */
const TABLE: Record<Exclude<PanelKind, "decision">, Record<PanelIntent, Placement>> = {
  run: { glance: { surface: "ambient" }, inline: { surface: "inline", inline: "card" }, follow: { surface: "dock" }, inspect: { surface: "sheet" } },
  plan: { glance: { surface: "ambient" }, inline: { surface: "inline", inline: "card" }, follow: { surface: "dock" }, inspect: { surface: "sheet" } },
  document: { glance: { surface: "none" }, inline: { surface: "inline", inline: "collapsed" }, follow: { surface: "dock" }, inspect: { surface: "sheet" } },
  stream: { glance: { surface: "ambient" }, inline: { surface: "inline", inline: "tail" }, follow: { surface: "dock" }, inspect: { surface: "sheet" } },
  collection: { glance: { surface: "none" }, inline: { surface: "inline", inline: "card" }, follow: { surface: "dock" }, inspect: { surface: "sheet" } },
};

describe("placePanel", () => {
  it("is the table, on desktop and tablet", () => {
    for (const [kind, row] of Object.entries(TABLE) as Array<[Exclude<PanelKind, "decision">, Record<PanelIntent, Placement>]>) {
      for (const intent of intents) {
        expect(placePanel(kind, intent, "desktop"), `${kind} × ${intent}`).toEqual(row[intent]);
        expect(placePanel(kind, intent, "tablet"), `${kind} × ${intent} (tablet)`).toEqual(row[intent]);
      }
    }
  });

  it("has exactly one branch: on a phone the dock becomes a sheet, everything else is unchanged", () => {
    for (const [kind, row] of Object.entries(TABLE) as Array<[Exclude<PanelKind, "decision">, Record<PanelIntent, Placement>]>) {
      for (const intent of intents) {
        const expected = row[intent].surface === "dock" ? { surface: "sheet", via: "phone-follow" } : row[intent];
        expect(placePanel(kind, intent, "mobile"), `${kind} × ${intent} (mobile)`).toEqual(expected);
      }
    }
  });

  it("keeps `inspect` and a phone's `follow` apart even though both read `sheet`", () => {
    const run = { kind: "run", id: "r", source: "s", title: "t", intent: "inspect", lifecycle: "running" } as const;
    // Same surface, opposite meaning: one opens, one waits above the composer.
    expect(placementOf(run, "mobile")).toEqual({ surface: "sheet" });
    expect(placementOf({ ...run, intent: "follow" }, "mobile")).toEqual({ surface: "sheet", via: "phone-follow" });
    expect(isIsland(run, "mobile")).toBe(false);
    expect(wantsInspectSheet(run, "mobile")).toBe(true);
    expect(wantsInspectSheet(run, "desktop")).toBe(true);
    expect(wantsInspectSheet({ ...run, intent: "follow" }, "mobile")).toBe(false);
    expect(wantsInspectSheet({ ...run, intent: "follow" }, "desktop")).toBe(false);
  });

  it("places a decision by what it blocks, not by intent", () => {
    for (const intent of intents) {
      expect(placePanel("decision", intent, "desktop", { blocking: "session" })).toEqual({ surface: "sheet" });
      expect(placePanel("decision", intent, "desktop", { blocking: "tool", hasToolRow: true })).toEqual({ surface: "inline", inline: "tool-row" });
      // A tool-scoped decision whose row is gone still has somewhere to go.
      expect(placePanel("decision", intent, "desktop", { blocking: "tool", hasToolRow: false })).toEqual({ surface: "inline", inline: "card" });
      expect(placePanel("decision", intent, "mobile", { blocking: "turn" })).toEqual({ surface: "inline", inline: "card" });
    }
  });

  it("islands are what the dock would hold; on a phone the same panels become chip-and-sheet", () => {
    const run = { kind: "run", id: "r", source: "s", title: "t", intent: "follow", lifecycle: "running" } as const;
    expect(isIsland(run, "desktop")).toBe(true);
    expect(isIsland(run, "mobile")).toBe(true);
    expect(isIsland({ ...run, intent: "glance" }, "desktop")).toBe(false);
    expect(placementOf({ ...run, intent: "inspect" }, "desktop")).toEqual({ surface: "sheet" });
    expect(isIsland({ ...run, intent: "inspect" }, "mobile")).toBe(false);
    const decision = {
      kind: "decision",
      id: "d",
      source: "s",
      title: "t",
      intent: "inspect",
      blocking: "session",
      fields: [{ id: "ok", label: "ok", type: "confirm" }],
    } as const;
    expect(isIsland(decision, "mobile")).toBe(false);
  });
});
