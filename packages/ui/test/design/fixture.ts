/**
 * One Design body, the way the host answers with it (M21-T11).
 *
 * Two tree screens wired by a flow, one dialog screen an overlay opens, and
 * one sketch — every shape the canvas has to draw, in one bounded body that
 * validates against the protocol's own schema.
 */
import type { ClientRequests, DesignBody, DesignIndex, DesignNode, DesignTokenGroup } from "@lasercode/protocol";
import { designBodySchema } from "@lasercode/protocol";

type Detail = ClientRequests["project/work/get"]["result"];

export const DIGEST = "d".repeat(64);

export function node(id: string, extra: Partial<DesignNode> = {}): DesignNode {
  return { id, component: { primitive: "text" }, fidelity: "mapped", props: {}, children: [], ...extra };
}

export function tokensDocument(): DesignTokenGroup {
  return {
    color: {
      brand: { "500": { $type: "color", $value: "#1f2937" } },
      action: { base: { $type: "color", $value: "{color.brand.500}" }, ink: { $type: "color", $value: "#ffffff" } },
      ink: { base: { $type: "color", $value: "#111111" }, muted: { $type: "color", $value: "#555555" } },
    },
    space: { unit: { $type: "dimension", $value: "4px" }, sm: { $type: "dimension", $value: "8px" }, lg: { $type: "dimension", $value: "24px" } },
    radius: { md: { $type: "dimension", $value: "6px" } },
  };
}

export function designFixture(over: Partial<DesignBody> = {}): DesignBody {
  const body: DesignBody = {
    brief: "A billing screen where a person can pay an invoice and see what happened.",
    designIndexRef: { indexId: "idx_1", revisionId: "rev_1", profileDigest: DIGEST },
    screens: [
      {
        id: "scr_list",
        name: "Invoices",
        viewport: "laptop",
        content: {
          tree: {
            rootNodeId: "n_root",
            nodes: [
              node("n_root", { component: { primitive: "stack" }, children: ["n_title", "n_table", "n_actions"] }),
              node("n_title", { variant: "heading", text: "Invoices" }),
              node("n_table", { component: { primitive: "table" }, props: { rows: { type: "fixture", fixtureId: "fx_invoices" } } }),
              node("n_actions", { component: { primitive: "stack" }, variant: "row", children: ["n_pay", "n_help"] }),
              node("n_pay", { component: { primitive: "button" }, variant: "primary", text: "Pay now", props: { label: { type: "text", value: "Pay now" } } }),
              node("n_help", { component: { indexEntryId: "e_help" }, fidelity: "mapped", unreviewed: true, text: "Help" }),
            ],
          },
        },
        states: [
          { name: "loading", included: true },
          { name: "offline", included: false, skipReason: "Billing needs a connection; the app's own offline state applies." },
        ],
        fidelity: "mapped",
      },
      {
        id: "scr_pay",
        name: "Pay an invoice",
        viewport: "laptop",
        content: {
          tree: {
            rootNodeId: "p_root",
            nodes: [
              node("p_root", { component: { primitive: "stack" }, children: ["p_title", "p_amount", "p_confirm"] }),
              node("p_title", { variant: "heading", text: "Pay an invoice" }),
              node("p_amount", { component: { primitive: "input" }, props: { label: { type: "text", value: "Amount" }, placeholder: { type: "text", value: "0.00" } } }),
              node("p_confirm", { component: { primitive: "button" }, variant: "primary", text: "Confirm", fidelity: "proposed" }),
            ],
          },
        },
        states: [],
        fidelity: "proposed",
      },
      {
        id: "scr_done",
        name: "Paid",
        content: {
          tree: {
            rootNodeId: "d_root",
            nodes: [node("d_root", { component: { primitive: "dialog" }, props: { title: { type: "text", value: "Paid" } }, children: ["d_close"] }), node("d_close", { component: { primitive: "button" }, variant: "secondary", text: "Close" })],
          },
        },
        states: [],
        fidelity: "mapped",
      },
      {
        id: "scr_sketch",
        name: "Filter demo",
        content: { sketchId: "sk_1" },
        states: [],
        fidelity: "sketch",
      },
    ],
    flows: [
      { id: "f_pay", fromScreenId: "scr_list", fromNodeId: "n_pay", trigger: "click", action: { type: "navigate", screenId: "scr_pay" } },
      { id: "f_confirm", fromScreenId: "scr_pay", fromNodeId: "p_confirm", trigger: "click", action: { type: "overlay", screenId: "scr_done" } },
      { id: "f_close", fromScreenId: "scr_done", fromNodeId: "d_close", trigger: "click", action: { type: "close" } },
      { id: "f_loading", fromScreenId: "scr_list", fromNodeId: "n_title", trigger: "click", action: { type: "setState", nodeId: "n_table", state: "loading" } },
    ],
    sketches: [
      {
        id: "sk_1",
        title: "Filter demo <b>bold</b>",
        blobId: "blob_sk_1",
        bytes: 1800,
        digest: DIGEST,
        createdAt: "2026-02-03T09:00:00.000Z",
        bounds: { width: 640, height: 400 },
      },
    ],
    fidelity: "sketch",
    fixtures: [{ id: "fx_invoices", name: "Invoices", rows: 4 }],
    ...over,
  };
  return designBodySchema.parse(body) as DesignBody;
}

/** A sketch-only design, which cannot pass a gate (D-354). */
export function sketchOnlyFixture(): DesignBody {
  const base = designFixture();
  return designBodySchema.parse({
    ...base,
    screens: base.screens.filter((screen) => "sketchId" in screen.content),
    flows: [],
    fidelity: "sketch",
  }) as DesignBody;
}

export function indexFixture(): DesignIndex {
  return {
    indexId: "idx_1",
    stack: { frameworks: ["React"], styling: ["Tailwind"] },
    eras: [{ id: "era_1", name: "current", roots: ["src"], useForNewWork: true }],
    entries: [
      {
        id: "e_help",
        kind: "component",
        name: "HelpLink",
        eraId: "era_1",
        summary: "The link to the docs.",
        sources: [{ path: "src/components/HelpLink.tsx" }],
        confidence: "observed",
        review: { state: "unreviewed" },
      },
      {
        id: "e_button",
        kind: "component",
        name: "Button",
        eraId: "era_1",
        sources: [{ path: "src/components/Button.tsx" }],
        confidence: "declared",
        review: { state: "accepted", reviewer: "Rae" },
      },
      {
        id: "t_brand",
        kind: "token",
        name: "color.brand.500",
        eraId: "era_1",
        sources: [{ path: "src/tokens.css" }],
        confidence: "declared",
        review: { state: "accepted" },
      },
    ],
    gaps: [],
    builtAt: "2026-02-03T08:00:00.000Z",
    tokensDocument: tokensDocument(),
  };
}

export function designDetail(body: DesignBody, options: { comments?: Detail["comments"] } = {}): Detail {
  const text = JSON.stringify({ kind: "design", design: body });
  const digest = "a".repeat(64);
  return {
    ref: { projectId: "p1", kind: "design", entityId: "e1", revisionId: "r1", digest, label: "DES-3", key: "DES-3" },
    entity: {
      projectId: "p1",
      entityId: "e1",
      kind: "design",
      key: "DES-3",
      keyNumber: 3,
      title: "Billing",
      state: "draft",
      currentRevisionId: "r1",
      currentDigest: digest,
      revisionCount: 1,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
      origin: { actor: { kind: "person", label: "You" } },
    },
    revision: {
      projectId: "p1",
      entityId: "e1",
      revisionId: "r1",
      index: 1,
      digest,
      title: "Billing",
      createdAt: "2026-02-02T00:00:00.000Z",
      origin: { actor: { kind: "person", label: "You" } },
      bodyBytes: text.length,
    },
    fence: { entityId: "e1", revisionId: "r1", digest, seq: 7 },
    body: { encoding: "application/json", totalBytes: text.length, offset: 0, bytes: text.length, text, body: { kind: "design", design: body } },
    edges: [],
    repositoryLinks: [],
    executionLinks: [],
    comments: options.comments ?? [],
    approvals: [],
    evidence: [],
    decisions: [],
    truncated: [],
  } as unknown as Detail;
}
