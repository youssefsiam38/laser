/**
 * The `DesignTree` rules a shape cannot express (M21-T11, D-353, D-354).
 *
 * Three promises are pinned here, because the renderer, the composer tool and
 * the inspector all rest on them:
 *
 * 1. **Nothing executable reaches the renderer.** Handlers, markup, script
 *    URLs and CSS blocks are refused wherever they hide — a prop name, a prop
 *    value, a node's text.
 * 2. **A tree is a tree, of stable ids.** Duplicates, cycles, orphans and a
 *    child with two parents are all refusals, because a comment anchored to a
 *    node id must survive an edit.
 * 3. **A stored body survives the shape it was written in.** `native` reads as
 *    `proposed` (Native is Build evidence, D-353), React-shaped fields are
 *    dropped by name, and a body already current comes back identical.
 *
 * Plus the DTCG flattening the frame renders with, and the "nearest token"
 * a refused free value is offered instead.
 */
import { describe, expect, it } from "vitest";
import {
  designBodySchema,
  designTokenCustomProperties,
  designTokenProperty,
  flattenDesignTokens,
  migrateDesignBody,
  screenFidelity,
  suggestNearestToken,
  suggestTokenForValue,
  validateDesignBody,
  validateDesignTree,
  type DesignBody,
  type DesignNode,
  type DesignTokenGroup,
} from "../src/index.js";

const DIGEST = "b".repeat(64);

function node(id: string, extra: Partial<DesignNode> = {}): DesignNode {
  return { id, component: { primitive: "text" }, fidelity: "mapped", props: {}, children: [], ...extra };
}

function body(overrides: Partial<DesignBody> = {}): DesignBody {
  return {
    brief: "A settings screen for the new billing area.",
    screens: [
      {
        id: "scr_1",
        name: "Billing",
        content: { tree: { rootNodeId: "n_root", nodes: [node("n_root", { component: { primitive: "stack" }, children: ["n_title"] }), node("n_title", { text: "Billing" })] } },
        states: [],
        fidelity: "mapped",
      },
    ],
    flows: [],
    sketches: [],
    fidelity: "mapped",
    fixtures: [],
    ...overrides,
  };
}

describe("validateDesignTree", () => {
  it("accepts a composed tree of stable ids", () => {
    const result = validateDesignTree(
      { rootNodeId: "n_root", nodes: [node("n_root", { children: ["n_a"] }), node("n_a", { text: "Pay now" })] },
      { primitives: ["text", "stack", "button"] },
    );
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("refuses an event handler on a node, whatever it is called", () => {
    for (const name of ["onClick", "onKeyDown", "onSubmit"]) {
      const result = validateDesignTree({
        rootNodeId: "n_root",
        nodes: [node("n_root", { props: { [name]: { type: "text", value: "doThing()" } } })],
      });
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("event_handler");
      expect(result.issues[0]?.message).toContain("declarative flow");
    }
  });

  it("refuses the renderer's own fields as props", () => {
    const result = validateDesignTree({
      rootNodeId: "n_root",
      nodes: [
        node("n_root", {
          props: { className: { type: "text", value: "p-4" }, dangerouslySetInnerHTML: { type: "text", value: "x" } },
        }),
      ],
    });
    expect(result.issues.map((issue) => issue.code).sort()).toEqual(["raw_markup", "raw_markup"]);
  });

  it("refuses markup, script and a CSS rule in a prop value or in text", () => {
    const cases: Array<[string, string]> = [
      ["label", "<script>alert(1)</script>"],
      ["label", "<b>bold</b>"],
      ["label", "a { color: red }"],
      ["label", "@import url(evil.css)"],
    ];
    for (const [name, value] of cases) {
      const result = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { props: { [name]: { type: "text", value } } })] });
      expect(result.ok, `${name}=${value}`).toBe(false);
      expect(["raw_markup", "raw_css"]).toContain(result.issues[0]?.code);
    }
    const text = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { text: "<img src=x onerror=1>" })] });
    expect(text.issues[0]?.code).toBe("raw_markup");
  });

  it("refuses a script URL and an unvalidated scheme, and allows https and a path", () => {
    const refused = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " \u0001javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd", "ftp://host/x"];
    for (const value of refused) {
      const result = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { props: { href: { type: "text", value } } })] });
      expect(result.ok, value).toBe(false);
      expect(["script_url", "unvalidated_url", "raw_css"]).toContain(result.issues[0]?.code);
    }
    for (const value of ["https://example.com/pricing", "/settings/billing", "mailto:someone@example.com"]) {
      const result = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { props: { href: { type: "text", value } } })] });
      expect(result.ok, value).toBe(true);
    }
  });

  it("refuses duplicate ids, a missing child, two parents, a cycle and an orphan", () => {
    const duplicate = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root"), node("n_root")] });
    expect(duplicate.issues[0]?.code).toBe("duplicate_id");

    const missing = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { children: ["n_gone"] })] });
    expect(missing.issues.map((issue) => issue.code)).toContain("missing_child");

    const shared = validateDesignTree({
      rootNodeId: "n_root",
      nodes: [node("n_root", { children: ["n_a", "n_b"] }), node("n_a", { children: ["n_c"] }), node("n_b", { children: ["n_c"] }), node("n_c")],
    });
    expect(shared.issues.map((issue) => issue.code)).toContain("multiple_parents");

    const cycle = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { children: ["n_a"] }), node("n_a", { children: ["n_root"] })] });
    expect(cycle.issues.map((issue) => issue.code)).toContain("cycle");

    const orphan = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root"), node("n_loose")] });
    expect(orphan.issues.map((issue) => issue.code)).toContain("unreachable");

    const badId = validateDesignTree({ rootNodeId: "n root", nodes: [node("n root")] });
    expect(badId.issues.map((issue) => issue.code)).toContain("id_shape");
  });

  it("names the nearest token when a node references one the index does not have", () => {
    const result = validateDesignTree(
      { rootNodeId: "n_root", nodes: [node("n_root", { props: { background: { type: "token", tokenId: "color.brand.50" } } })] },
      { tokenIds: ["color.brand.500", "color.surface.base"] },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("unknown_token");
    expect(result.issues[0]?.suggestion).toBe("color.brand.500");
  });

  it("names the nearest primitive when the kit has no such component", () => {
    const result = validateDesignTree({ rootNodeId: "n_root", nodes: [node("n_root", { component: { primitive: "buton" } })] }, { primitives: ["button", "card"] });
    expect(result.issues[0]).toMatchObject({ code: "unknown_primitive", suggestion: "button" });
  });
});

describe("validateDesignBody", () => {
  it("accepts declarative flows and refuses ones that point nowhere", () => {
    const ok = validateDesignBody(
      body({
        screens: [
          { id: "scr_1", name: "List", content: { tree: { rootNodeId: "n_root", nodes: [node("n_root", { children: ["n_go"] }), node("n_go")] } }, states: [], fidelity: "mapped" },
          { id: "scr_2", name: "Detail", content: { tree: { rootNodeId: "n_d", nodes: [node("n_d")] } }, states: [], fidelity: "mapped" },
        ],
        flows: [{ id: "f_1", fromScreenId: "scr_1", fromNodeId: "n_go", trigger: "click", action: { type: "navigate", screenId: "scr_2" } }],
      }),
    );
    expect(ok).toEqual({ ok: true, issues: [] });

    const broken = validateDesignBody(body({ flows: [{ id: "f_1", fromScreenId: "scr_1", trigger: "click", action: { type: "navigate", screenId: "scr_missing" } }] }));
    expect(broken.ok).toBe(false);
    expect(broken.issues[0]?.code).toBe("unknown_screen");
  });

  it("reads a screen's fidelity from its least grounded node", () => {
    const screen = body().screens[0];
    expect(screen && screenFidelity(screen)).toBe("mapped");
    const proposed = body({
      screens: [
        {
          id: "scr_1",
          name: "Billing",
          content: { tree: { rootNodeId: "n_root", nodes: [node("n_root", { children: ["n_new"] }), node("n_new", { fidelity: "proposed" })] } },
          states: [],
          fidelity: "mapped",
        },
      ],
    }).screens[0];
    expect(proposed && screenFidelity(proposed)).toBe("proposed");
  });
});

describe("migrateDesignBody", () => {
  it("round-trips a current body unchanged", () => {
    const current = designBodySchema.parse(body()) as DesignBody;
    const first = migrateDesignBody(current);
    expect(first.changes).toEqual([]);
    expect(first.body).toEqual(current);
    const second = migrateDesignBody(first.body);
    expect(second.body).toEqual(first.body);
    expect(JSON.parse(JSON.stringify(second.body))).toEqual(JSON.parse(JSON.stringify(current)));
  });

  it("reads Native as Proposed, because Native is Build evidence", () => {
    const legacy = { ...body(), fidelity: "native" };
    const migrated = migrateDesignBody(legacy);
    expect(migrated.body.fidelity).toBe("proposed");
    expect(migrated.changes[0]).toContain("Build evidence");
    expect(designBodySchema.safeParse(migrated.body).success).toBe(true);
  });

  it("drops the renderer's fields and the pre-sketch screen shape", () => {
    const legacy = {
      brief: "An older revision.",
      screens: [
        {
          id: "scr_1",
          name: "Billing",
          rootNodeId: "n_root",
          nodes: [{ id: "n_root", component: { primitive: "stack" }, fidelity: "mapped", props: { onClick: { type: "text", value: "go()" } }, children: [], className: "p-4", style: "color:red" }],
          fidelity: "mapped",
        },
      ],
      fidelity: "mapped",
    };
    const migrated = migrateDesignBody(legacy);
    const screen = migrated.body.screens[0];
    expect(screen && "tree" in screen.content).toBe(true);
    const first = screen && "tree" in screen.content ? screen.content.tree.nodes[0] : undefined;
    expect(first?.props).toEqual({});
    expect(JSON.stringify(migrated.body)).not.toContain("className");
    expect(JSON.stringify(migrated.body)).not.toContain("onClick");
    expect(migrated.changes.some((change) => change.includes("className"))).toBe(true);
    expect(designBodySchema.safeParse(migrated.body).success).toBe(true);
  });

  it("keeps no React-specific field anywhere in the protocol shape", () => {
    const shaped = designBodySchema.parse(
      body({
        screens: [
          {
            id: "scr_1",
            name: "Billing",
            content: {
              tree: {
                rootNodeId: "n_root",
                nodes: [node("n_root", { children: ["n_a"], variant: "compact", state: "loading" }), node("n_a", { props: { label: { type: "text", value: "Pay" } }, text: "Pay" })],
              },
            },
            states: [{ name: "loading", included: true }],
            fidelity: "mapped",
          },
        ],
        sketches: [
          { id: "sk_1", title: "Filter demo", blobId: "blob_1", bytes: 2048, digest: DIGEST, createdAt: "2026-02-01T10:00:00.000Z", bounds: { width: 900, height: 600 } },
        ],
      }),
    );
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(shaped);
    for (const forbidden of ["className", "class", "style", "ref", "key", "onClick", "onChange", "dangerouslySetInnerHTML", "jsx", "html", "sandbox", "srcDoc"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    // `children` exists, and is ids — never rendered nodes.
    const screen = shaped.screens[0];
    const root = screen && "tree" in screen.content ? screen.content.tree.nodes[0] : undefined;
    expect(root?.children).toEqual(["n_a"]);
    expect(root?.children.every((child) => typeof child === "string")).toBe(true);
  });
});

describe("DTCG tokens", () => {
  const document: DesignTokenGroup = {
    color: {
      brand: { "500": { $type: "color", $value: "#1f2937", $description: "The one brand colour." } },
      surface: { base: { $type: "color", $value: "{color.brand.500}" } },
    },
    space: { sm: { $type: "dimension", $value: "8px" } },
    shadow: { card: { $type: "shadow", $value: { offsetX: "0", offsetY: "2px", blur: "8px", color: "#0003" } } },
    danger: { injected: { $value: "red; position: fixed" }, remote: { $value: "url(https://evil.example/x.png)" } },
  };

  it("flattens a document to prefixed custom properties, aliases included", () => {
    const flat = flattenDesignTokens(document);
    const byPath = new Map(flat.tokens.map((token) => [token.path, token]));
    expect(byPath.get("color.brand.500")).toMatchObject({ property: "--design-color-brand-500", value: "#1f2937", type: "color" });
    expect(byPath.get("color.surface.base")?.value).toBe("var(--design-color-brand-500)");
    expect(byPath.get("space.sm")?.value).toBe("8px");
    expect(byPath.get("shadow.card")?.value).toBe("0 2px 8px #0003");
  });

  it("refuses a token value that could escape its declaration", () => {
    const flat = flattenDesignTokens(document);
    expect(flat.tokens.some((token) => token.path.startsWith("danger."))).toBe(false);
    expect(flat.skipped.map((entry) => entry.path).sort()).toEqual(["danger.injected", "danger.remote"]);
    expect(flat.skipped[0]?.reason).toContain("end the declaration");
  });

  it("gives a custom property map a frame can set on its root", () => {
    const properties = designTokenCustomProperties(document);
    expect(properties["--design-color-brand-500"]).toBe("#1f2937");
    expect(Object.keys(properties).every((name) => name.startsWith("--design-"))).toBe(true);
    expect(designTokenCustomProperties(undefined)).toEqual({});
  });

  it("names a property from a path, camelCase and all", () => {
    expect(designTokenProperty("type.fontSize.body")).toBe("--design-type-font-size-body");
    expect(designTokenProperty("color.Brand/500")).toBe("--design-color-brand-500");
  });
});

describe("the nearest token", () => {
  const tokens = flattenDesignTokens({
    color: { brand: { "500": { $type: "color", $value: "#1f2937" } }, ink: { base: { $type: "color", $value: "#ffffff" } } },
    space: { sm: { $type: "dimension", $value: "8px" }, lg: { $type: "dimension", $value: "24px" } },
  }).tokens;

  it("suggests by colour distance, not by name", () => {
    expect(suggestTokenForValue("#1f2938", tokens)?.path).toBe("color.brand.500");
    expect(suggestTokenForValue("rgb(255,255,255)", tokens)?.path).toBe("color.ink.base");
  });

  it("suggests by size for a dimension", () => {
    expect(suggestTokenForValue("9px", tokens)?.path).toBe("space.sm");
    expect(suggestTokenForValue("1.5rem", tokens)?.path).toBe("space.lg");
  });

  it("says nothing rather than suggesting something absurd", () => {
    expect(suggestNearestToken("completely-unrelated-name", ["color.brand.500"])).toBeUndefined();
    expect(suggestNearestToken("color.brand.50", ["color.brand.500"])).toBe("color.brand.500");
  });
});
