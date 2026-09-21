/**
 * The structural outline and the insertion regions anchored to it (M21-T12).
 *
 * What is proved here: the path survives cosmetics, the hash follows the
 * words, and an anchor that cannot be found again is reported as orphaned
 * with a reason rather than quietly re-pointed at something else
 * (`docs/design-phase.md`, "Insertion region").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  insertionRegionFromBox,
  insertionRegionFromNode,
  regionAfterResolution,
  resolveRegionAgainstOutline,
} from "../../src/design/host/insertion-region.js";
import { composeHostOutline, outlineAnchors, outlineNodeAt, outlineTemplate, toProtocolOutline } from "../../src/design/host/outline.js";
import { FIXTURE_ROOT } from "./helpers.js";

const RAILS_VIEW = "app/views/invoices/index.html.erb";

function fixtureText(path: string): string {
  return readFileSync(join(FIXTURE_ROOT, path), "utf8");
}

const railsView = fixtureText(`host-rails/${RAILS_VIEW}`);

function outlineOf(text: string, path = RAILS_VIEW) {
  return outlineTemplate({ path, text });
}

describe("the outline of an ERB view", () => {
  const outline = outlineOf(railsView);

  it("reads regions, headings, tables, forms and partials, each with a path and a hash", () => {
    expect(outline.nodes.map((node) => `${node.structuralPath} ${node.role}`)).toEqual([
      "/section[0] section",
      "/section[0]/heading[0] heading",
      "/section[0]/partial[0] partial",
      "/section[0]/table[0] table",
      "/section[0]/table[0]/partial[0] partial",
      "/section[0]/section[0] section",
      "/section[0]/section[0]/heading[0] heading",
    ]);
    expect(outline.nodes[1]?.label).toBe("Invoices");
    expect(outline.nodes[2]?.label).toBe("shared/filters");
    for (const node of outline.nodes) expect(node.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never evaluates an expression: the ERB is erased, not run", () => {
    // `<%= invoice.number %>` contributes nothing, so a rename in the model
    // does not change a single hash.
    const renamed = outlineOf(railsView.replace(/@invoices/g, "@records").replace("invoice.name", "invoice.title"));
    expect(renamed.nodes.map((node) => node.textHash)).toEqual(outline.nodes.map((node) => node.textHash));
  });

  it("gives a partial the file it renders, when the caller resolved it", () => {
    const resolved = outlineTemplate(
      { path: RAILS_VIEW, text: railsView },
      { resolvePartial: (name) => (name === "shared/filters" ? "app/views/shared/_filters.html.erb" : undefined) },
    );
    expect(resolved.nodes[2]?.sourcePath).toBe("app/views/shared/_filters.html.erb");
    expect(resolved.nodes[4]?.sourcePath).toBeUndefined();
  });
});

describe("outline stability", () => {
  const outline = outlineOf(railsView);

  it("survives re-indentation, attribute order and an extra wrapper", () => {
    const reformatted = railsView
      .replace('<section class="panel panel-default">', '<section  data-test="x"\n   class="panel panel-default"\n>')
      .replace('<table class="table table-striped">', '<div class="scroller">\n<table\n  class="table table-striped">')
      .replace("</table>", "</table>\n</div>")
      .replace(/\n/g, "\n  ");
    const after = outlineOf(reformatted);
    expect(after.nodes.map((node) => node.structuralPath)).toEqual(outline.nodes.map((node) => node.structuralPath));
    expect(after.nodes.map((node) => node.textHash)).toEqual(outline.nodes.map((node) => node.textHash));
    expect(after.nodes.map((node) => node.id)).toEqual(outline.nodes.map((node) => node.id));
  });

  it("moves the hash when the words move", () => {
    const edited = outlineOf(railsView.replace("Nothing outstanding", "All settled up"));
    const before = outlineNodeAt(outline, RAILS_VIEW, "/section[0]/section[0]");
    const after = outlineNodeAt(edited, RAILS_VIEW, "/section[0]/section[0]");
    expect(after?.textHash).not.toBe(before?.textHash);
    // The heading above it did not move, so its own hash did not either.
    expect(outlineNodeAt(edited, RAILS_VIEW, "/section[0]/heading[0]")?.textHash).toBe(outlineNodeAt(outline, RAILS_VIEW, "/section[0]/heading[0]")?.textHash);
  });
});

describe("a composed outline", () => {
  const outline = composeHostOutline({
    files: [
      { path: "app/views/layouts/application.html.erb", text: fixtureText("host-rails/app/views/layouts/application.html.erb") },
      { path: RAILS_VIEW, text: railsView },
      { path: "app/views/shared/_filters.html.erb", text: fixtureText("host-rails/app/views/shared/_filters.html.erb") },
    ],
  });

  it("puts a template node at the top of each file's structure", () => {
    const templates = outline.nodes.filter((node) => node.role === "template");
    expect(templates.map((node) => node.templatePath)).toEqual([
      "app/views/layouts/application.html.erb",
      RAILS_VIEW,
      "app/views/shared/_filters.html.erb",
    ]);
    expect(templates.every((node) => node.depth === 0 && node.structuralPath === "/")).toBe(true);
    expect(outlineNodeAt(outline, RAILS_VIEW, "/section[0]")?.depth).toBe(1);
  });

  it("keeps each file's paths to itself, so editing the layout renumbers nothing", () => {
    const layoutPaths = outline.nodes.filter((node) => node.templatePath.includes("layouts")).map((node) => node.structuralPath);
    const viewPaths = outline.nodes.filter((node) => node.templatePath === RAILS_VIEW).map((node) => node.structuralPath);
    expect(layoutPaths).toContain("/main[0]");
    expect(viewPaths).toContain("/section[0]");
  });

  it("is what a HostPage carries, within the protocol's bounds", () => {
    const carried = toProtocolOutline(outline);
    expect(carried.length).toBe(outline.nodes.length);
    expect(carried[0]).toMatchObject({ role: "template", depth: 0, structuralPath: "/" });
    for (const node of carried) {
      expect(node.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(node.textHash).toMatch(/^[0-9a-f]{64}$/);
      expect(node.depth).toBeLessThanOrEqual(32);
    }
  });

  it("stops at its node budget and says so", () => {
    const big = composeHostOutline({ files: [{ path: RAILS_VIEW, text: railsView }], maxNodes: 3 });
    expect(big.nodes.length).toBeLessThanOrEqual(3);
    expect(big.truncated).toBe(true);
    expect(big.gaps[0]?.reason).toContain("more structure than one outline carries");
  });
});

describe("an insertion region", () => {
  const outline = outlineOf(railsView);
  const node = outlineNodeAt(outline, RAILS_VIEW, "/section[0]/section[0]")!;
  const region = insertionRegionFromNode(node);

  it("records the template, the structural path and the text hash", () => {
    expect(region).toMatchObject({ templatePath: RAILS_VIEW, structuralPath: "/section[0]/section[0]", textHash: node.textHash });
    expect(region.id).toMatch(/^ir_[0-9a-f]+$/);
    // The same node always produces the same region id.
    expect(insertionRegionFromNode(node).id).toBe(region.id);
  });

  it("resolves against the same template, and survives a cosmetic edit", () => {
    expect(resolveRegionAgainstOutline(region, outline).state).toBe("resolved");
    const reformatted = outlineOf(railsView.replace('<section class="well">', '<section\n  data-role="empty"\n  class="well">'));
    const resolution = resolveRegionAgainstOutline(region, reformatted);
    expect(resolution.state).toBe("resolved");
    expect(resolution.nodeId).toBe(node.id);
    expect(regionAfterResolution(region, resolution).orphaned).toBeUndefined();
  });

  it("reports a text change instead of pretending the anchor is unchanged", () => {
    const edited = outlineOf(railsView.replace("Nothing outstanding", "All settled up"));
    const resolution = resolveRegionAgainstOutline(region, edited);
    expect(resolution.state).toBe("changed");
    expect(resolution.structuralPath).toBe("/section[0]/section[0]");
    expect(resolution.reason).toContain("changed since this region was recorded");
    // Still anchored: a changed anchor is not an orphaned one.
    expect(regionAfterResolution(region, resolution).orphaned).toBeUndefined();
  });

  it("is orphaned, with the reason, when the section is removed", () => {
    const removed = outlineOf(
      railsView.replace(/<section class="well">[\s\S]*?<\/section>/, ""),
    );
    const resolution = resolveRegionAgainstOutline(region, removed);
    expect(resolution.state).toBe("orphaned");
    expect(resolution.reason).toContain("no longer exists");
    expect(resolution.candidate).toBeUndefined();
    expect(regionAfterResolution(region, resolution).orphaned).toBe(true);
    // The path a person picked is still the path the region carries.
    expect(regionAfterResolution(region, resolution).structuralPath).toBe("/section[0]/section[0]");
  });

  it("is orphaned — never moved — when the same content turns up elsewhere", () => {
    const moved = railsView
      .replace(/<section class="well">[\s\S]*?<\/section>/, "")
      .replace("</section>", `</section>\n<section class="well">\n  <h3>Nothing outstanding</h3>\n  <p>No results yet.</p>\n</section>`);
    const resolution = resolveRegionAgainstOutline(region, outlineOf(moved));
    expect(resolution.state).toBe("orphaned");
    expect(resolution.candidate?.structuralPath).toBe("/section[1]");
    expect(resolution.reason).toContain("nothing was moved for you");
  });

  it("is orphaned when the template is no longer part of the page at all", () => {
    const elsewhere = outlineOf(railsView, "app/views/invoices/show.html.erb");
    const resolution = resolveRegionAgainstOutline(region, elsewhere);
    expect(resolution.state).toBe("orphaned");
    expect(resolution.reason).toContain("not part of this page any more");
  });

  it("offers every node of one template as an anchor, and no other template's", () => {
    const composed = composeHostOutline({
      files: [
        { path: "app/views/layouts/application.html.erb", text: fixtureText("host-rails/app/views/layouts/application.html.erb") },
        { path: RAILS_VIEW, text: railsView },
      ],
    });
    const anchors = outlineAnchors(composed, RAILS_VIEW);
    expect(anchors.some((anchor) => anchor.structuralPath === "/main[0]")).toBe(false);
    expect(anchors.some((anchor) => anchor.structuralPath === "/section[0]/table[0]")).toBe(true);
  });
});

describe("a region drawn as a box", () => {
  const outline = outlineOf(railsView);
  const node = outlineNodeAt(outline, RAILS_VIEW, "/section[0]/table[0]")!;

  it("anchors to the node under it when there is one", () => {
    const region = insertionRegionFromBox({ templatePath: RAILS_VIEW, box: { x: 10.123, y: 20, width: 300, height: 120 }, node });
    expect(region.structuralPath).toBe("/section[0]/table[0]");
    expect(region.box).toEqual({ x: 10.12, y: 20, width: 300, height: 120 });
    expect(resolveRegionAgainstOutline(region, outline).state).toBe("resolved");
  });

  it("says outright that a box on a reference image is not anchored to the template", () => {
    const region = insertionRegionFromBox({ templatePath: RAILS_VIEW, box: { x: 0, y: 0, width: 100, height: 40 }, label: "the empty strip" });
    expect(region.structuralPath).toBe("/reference-image");
    const resolution = resolveRegionAgainstOutline(region, outline);
    expect(resolution.state).toBe("orphaned");
    expect(resolution.reason).toContain("drawn on a reference image");
  });
});
