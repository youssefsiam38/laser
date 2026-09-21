/**
 * L0 · what the parsers actually read out of five real-shaped projects.
 *
 * Each fixture is a project shape the contract names: React + Tailwind +
 * Storybook, Vue with SCSS variables and typed props, Rails-style templates,
 * a two-era monorepo, and a project that already has DTCG tokens. The
 * assertions are about facts, not about our own phrasing: a token's value, a
 * component's variants, an era's root, a gap's existence.
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildFixture, cleanupFixtures, entriesOf, entryNamed } from "./helpers.js";
import { flattenTokenDocument } from "../../src/design/index/tokens.js";

afterAll(cleanupFixtures);

describe("a React + Tailwind + Storybook project", () => {
  it("reads its stack from the manifest and its config files by name", async () => {
    const { index } = await buildFixture("react-tailwind");
    expect(index.stack.frameworks).toContain("React");
    expect(index.stack.styling).toEqual(expect.arrayContaining(["Tailwind", "PostCSS", "Storybook"]));
    expect(index.stack.buildTool).toBe("Vite");
    expect(index.stack.packageManager).toBe("pnpm");
  });

  it("takes Tailwind theme values as text, and records the computed one as a gap", async () => {
    const { index } = await buildFixture("react-tailwind");
    const brand = entryNamed(index, "token", "colors.brand.500");
    expect(brand?.detail?.["value"]).toBe("#3b82f6");
    expect(brand?.confidence).toBe("declared");
    expect(entryNamed(index, "token", "screens.md")?.detail?.["value"]).toBe("768px");
    expect(entryNamed(index, "token", "spacing.gutter")?.detail?.["value"]).toBe("24px");
    // `colors.generated` is `require(...)`; it is a gap, never a guess.
    expect(index.entries.some((entry) => entry.name.includes("generated"))).toBe(false);
    expect(index.gaps.some((gap) => gap.path === "tailwind.config.js" && gap.reason.includes("computed"))).toBe(true);
  });

  it("reads custom properties, declarations and a repeated literal", async () => {
    const { index } = await buildFixture("react-tailwind");
    expect(entryNamed(index, "token", "color.brand")?.detail?.["value"]).toBe("#3b82f6");
    expect(entryNamed(index, "token", "shadow.card")?.detail?.["value"]).toBe("0 1px 2px rgba(17, 24, 39, 0.08)");
    // #6b7280 is written three times and declared nowhere: an observed cluster.
    const observed = entryNamed(index, "token", "color.observed.6b7280");
    expect(observed?.confidence).toBe("observed");
    expect(Number(observed?.detail?.["usages"])).toBeGreaterThanOrEqual(3);
  });

  it("reads components, their typed props, their variants and their status", async () => {
    const { index } = await buildFixture("react-tailwind");
    const button = entryNamed(index, "component", "Button");
    expect(button?.confidence).toBe("declared");
    expect(button?.detail?.["framework"]).toBe("React");
    expect(button?.detail?.["props"]).toContain("label");
    expect(button?.detail?.["variants"]).toContain("variant=primary");
    expect(button?.detail?.["variants"]).toContain("variant=ghost");
    expect(button?.detail?.["variants"]).toContain("size=lg");
    expect(button?.status).toBe("active");
    expect(entryNamed(index, "component", "LegacyButton")?.status).toBe("deprecated");
  });

  it("parses stories as text for examples", async () => {
    const { index } = await buildFixture("react-tailwind");
    const button = entryNamed(index, "component", "Button");
    expect(button?.detail?.["examples"]).toContain("Primary");
    expect(button?.detail?.["examples"]).toContain("Ghost");
    expect(button?.detail?.["exampleArgs"]).toContain("Save changes");
  });

  it("reads routes, hand-written states and the icon inventory", async () => {
    const { index } = await buildFixture("react-tailwind");
    const pages = entryNamed(index, "convention", "page template");
    expect(pages?.detail?.["routes"]).toContain("/settings");
    expect(pages?.detail?.["regions"]).toContain("form");
    expect(entryNamed(index, "convention", "empty state")).toBeDefined();
    expect(entryNamed(index, "convention", "error state")).toBeDefined();
    expect(entryNamed(index, "convention", "iconography")?.detail?.["sources"]).toContain("Lucide");
    expect(entriesOf(index, "asset").some((entry) => entry.name === "public/icons")).toBe(true);
  });

  it("writes a DTCG document whose tokens cite their sources", async () => {
    const { index } = await buildFixture("react-tailwind");
    const flat = flattenTokenDocument(index.tokensDocument ?? {});
    const brand = flat.find((token) => token.path === "colors.brand.500");
    expect(brand?.token.$type).toBe("color");
    expect(brand?.token.$value).toBe("#3b82f6");
    const provenance = Object.values(brand?.token.$extensions ?? {})[0];
    expect(provenance?.confidence).toBe("declared");
    expect(provenance?.sources[0]?.path).toBe("tailwind.config.js");
    expect(provenance?.sources[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a Vue project with SCSS variables and typed props", () => {
  it("reads the preprocessor variables as declared tokens", async () => {
    const { index } = await buildFixture("vue-scss");
    expect(index.stack.frameworks).toContain("Vue");
    expect(entryNamed(index, "token", "color.brand.500")?.detail?.["value"]).toBe("#0f766e");
    expect(entryNamed(index, "token", "space.md")?.detail?.["value"]).toBe("16px");
    expect(entryNamed(index, "token", "motion.duration.base")?.detail?.["value"]).toBe("200ms");
  });

  it("reads `defineProps<…>` and the options object", async () => {
    const { index } = await buildFixture("vue-scss");
    const card = entryNamed(index, "component", "Card");
    expect(card?.confidence).toBe("declared");
    expect(card?.detail?.["framework"]).toBe("Vue");
    expect(card?.detail?.["props"]).toContain("title");
    expect(card?.detail?.["variants"]).toContain("density=compact");
    const toolbar = entryNamed(index, "component", "Toolbar");
    expect(toolbar?.detail?.["props"]).toContain("title");
    expect(toolbar?.detail?.["props"]).toContain("compact?");
  });
});

describe("a Rails-style templates project", () => {
  it("reads the Gemfile, the views and the locale catalogue", async () => {
    const { index } = await buildFixture("rails-templates");
    expect(index.stack.frameworks).toContain("Rails");
    expect(index.stack.styling).toContain("Bootstrap");
    const pages = entryNamed(index, "convention", "page template");
    expect(pages?.detail?.["routes"]).toContain("/products");
    expect(entryNamed(index, "convention", "copy voice")?.detail?.["sample"]).toContain("No results yet.");
    expect(entryNamed(index, "convention", "empty state")).toBeDefined();
  });

  it("names the era from the template stack it found", async () => {
    const { index } = await buildFixture("rails-templates");
    expect(index.eras).toHaveLength(1);
    expect(index.eras[0]?.name).toContain("Rails");
    expect(index.eras[0]?.roots).toContain("app/views");
    expect(index.eras[0]?.useForNewWork).toBe(true);
  });
});

describe("a legacy Bootstrap + modern React monorepo", () => {
  it("finds two eras and proposes the modern one for new work", async () => {
    const { index } = await buildFixture("monorepo-eras");
    expect(index.eras).toHaveLength(2);
    const modern = index.eras.find((era) => era.roots.includes("packages/web"));
    const legacy = index.eras.find((era) => era.roots.includes("packages/legacy"));
    expect(modern?.useForNewWork).toBe(true);
    expect(legacy?.useForNewWork).toBe(false);
    expect(legacy?.name).toContain("Bootstrap");
  });

  it("files each component under the era it was parsed in", async () => {
    const { index } = await buildFixture("monorepo-eras");
    const modern = index.eras.find((era) => era.roots.includes("packages/web"));
    const button = entryNamed(index, "component", "Button");
    expect(button?.eraId).toBe(modern?.id);
    const era = index.entries.find((entry) => entry.kind === "era" && entry.id === modern?.id);
    expect(era?.summary).toMatch(/new work/i);
  });
});

describe("a project that already has DTCG tokens", () => {
  it("reads $value/$type leaves and keeps aliases as aliases", async () => {
    const { index } = await buildFixture("dtcg-tokens");
    const brand = entryNamed(index, "token", "color.brand.500");
    expect(brand?.detail?.["value"]).toBe("#7c3aed");
    expect(brand?.confidence).toBe("declared");
    const alias = entryNamed(index, "token", "semantic.action");
    expect(alias?.detail?.["value"]).toBe("{color.brand.500}");
    expect(alias?.detail?.["alias"]).toBe("true");
  });

  it("reads the Style Dictionary shape too", async () => {
    const { index } = await buildFixture("dtcg-tokens");
    expect(entryNamed(index, "token", "size.font.body")?.detail?.["value"]).toBe("16px");
  });
});

describe("every fixture", () => {
  it("records only project-relative source paths", async () => {
    for (const name of ["react-tailwind", "vue-scss", "rails-templates", "monorepo-eras", "dtcg-tokens"] as const) {
      const { index } = await buildFixture(name);
      for (const entry of index.entries) {
        for (const source of entry.sources) {
          expect(source.path.startsWith("/"), `${name}: ${source.path}`).toBe(false);
          expect(source.path.includes(".."), `${name}: ${source.path}`).toBe(false);
        }
      }
    }
  });

  it("is byte-identical when built twice from the same tree", async () => {
    const first = await buildFixture("react-tailwind");
    const second = await buildFixture("react-tailwind", { projectCwd: first.projectCwd });
    expect(JSON.stringify({ ...second.index, builtAt: "" })).toEqual(JSON.stringify({ ...first.index, builtAt: "" }));
  });
});
