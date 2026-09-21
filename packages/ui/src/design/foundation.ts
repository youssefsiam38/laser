/**
 * Foundation mode, window side (M21-T14).
 *
 * The rules — the order of the ten steps, what completes one, what the Design
 * Profile digest is taken over, what "superseded by the index" means — are the
 * protocol's, because the worker proposes against the same ones. What lives
 * here is what a *surface* needs on top of them:
 *
 * - the sample screens the canvas draws, composed out of the T11 kit and
 *   skinned by the proposal's own tokens, so a person sees the foundation
 *   rather than a list of hex values;
 * - editing a DTCG token in place, which is what the token editor writes;
 * - the Design Profile digest, taken with the browser's own crypto over the
 *   protocol's canonical bytes, so the window and the worker agree;
 * - the token-name diff a superseded foundation shows against the index.
 *
 * Nothing here talks to the host: writing is the detail's, through the store.
 */
import {
  flattenDesignTokens,
  foundationCanonicalJson,
  foundationTokenDiff,
  foundationTokenNames,
  type DesignBody,
  type DesignFoundation,
  type DesignNode,
  type DesignScreen,
  type DesignToken,
  type DesignTokenGroup,
  type FlatDesignToken,
  type FoundationComponentContract,
} from "@lasercode/protocol";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** One editable row of the foundation's token document. */
export interface FoundationTokenRow extends FlatDesignToken {
  /** The document this token lives in: the base, or a mode by name. */
  owner: { kind: "base" } | { kind: "mode"; name: string };
  /** The raw `$value` as written, which may be an alias like `{color.bg}`. */
  raw: string;
  /** True when the value points at another token instead of a literal. */
  alias: boolean;
}

function rowsOf(document: DesignTokenGroup | undefined, owner: FoundationTokenRow["owner"]): FoundationTokenRow[] {
  const flat = flattenDesignTokens(document);
  return flat.tokens.map((token) => {
    const raw = rawValue(document, token.path);
    return { ...token, owner, raw, alias: /^\{[^}]+\}$/.test(raw.trim()) };
  });
}

/** Every token of the foundation, base first, then each mode. */
export function foundationTokenRows(foundation: DesignFoundation | undefined): FoundationTokenRow[] {
  if (!foundation) return [];
  return [
    ...rowsOf(foundation.tokens, { kind: "base" }),
    ...(foundation.modes ?? []).flatMap((mode) => rowsOf(mode.tokens, { kind: "mode", name: mode.name })),
  ];
}

/** `color.bg` → the `$value` as it is written in the document. */
export function rawValue(document: DesignTokenGroup | undefined, path: string): string {
  const token = tokenAt(document, path);
  if (!token) return "";
  const value = token.$value;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return Object.values(value)
    .map((part) => String(part))
    .join(" ");
}

function tokenAt(document: DesignTokenGroup | undefined, path: string): DesignToken | undefined {
  let node: DesignTokenGroup | DesignToken | undefined = document;
  for (const segment of path.split(".")) {
    if (node === undefined || typeof node !== "object" || "$value" in node) return undefined;
    node = (node as DesignTokenGroup)[segment];
  }
  return node !== undefined && typeof node === "object" && "$value" in node ? (node as DesignToken) : undefined;
}

function setAt(document: DesignTokenGroup, path: string, value: string): DesignTokenGroup {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return document;
  const node = document[head];
  if (rest.length === 0) {
    if (node === undefined || !("$value" in node)) return document;
    return { ...document, [head]: { ...node, $value: value } };
  }
  if (node === undefined || "$value" in node) return document;
  return { ...document, [head]: setAt(node, rest.join("."), value) };
}

/**
 * Write one token's value.
 *
 * Only a token that already exists is written: adding names is a proposal's
 * job, not a field's, and a typed path that matches nothing would otherwise
 * silently grow the document.
 */
export function setFoundationToken(
  foundation: DesignFoundation,
  row: Pick<FoundationTokenRow, "owner" | "path">,
  value: string,
): DesignFoundation {
  if (row.owner.kind === "base") {
    return foundation.tokens ? { ...foundation, tokens: setAt(foundation.tokens, row.path, value) } : foundation;
  }
  const name = row.owner.name;
  return {
    ...foundation,
    modes: (foundation.modes ?? []).map((mode) => (mode.name === name ? { ...mode, tokens: setAt(mode.tokens, row.path, value) } : mode)),
  };
}

/** `color.bg` → `color`: the family the editor groups rows by. */
export function tokenFamily(path: string): string {
  return path.split(".")[0] ?? "other";
}

/** A token's value resolved through its aliases, for a contrast measurement. */
export function resolveTokenValue(foundation: DesignFoundation | undefined, row: FoundationTokenRow, depth = 8): string {
  if (!row.alias || depth <= 0) return row.raw;
  const target = row.raw.trim().slice(1, -1);
  const rows = foundationTokenRows(foundation);
  const next = rows.find((candidate) => candidate.path === target && candidate.owner.kind === row.owner.kind) ?? rows.find((candidate) => candidate.path === target);
  return next ? resolveTokenValue(foundation, next, depth - 1) : row.raw;
}

// ---------------------------------------------------------------------------
// The Design Profile digest
// ---------------------------------------------------------------------------

/**
 * The Design Profile digest v1, over the protocol's canonical bytes.
 *
 * The same bytes the worker hashes with Node's `createHash`; here the
 * browser's own `crypto.subtle` does it, so a foundation approved in this
 * window and one recorded by a tool carry the same digest.
 */
export async function foundationProfileDigest(foundation: DesignFoundation): Promise<string> {
  const bytes = new TextEncoder().encode(foundationCanonicalJson(foundation));
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The foundation as it reads once the person has approved it. */
export async function approvedFoundation(foundation: DesignFoundation, at: string): Promise<DesignFoundation> {
  const digest = await foundationProfileDigest(foundation);
  return { ...foundation, status: "approved", profile: { version: 1, digest, approvedAt: at } };
}

/** What a foundation shows once the built source has been indexed. */
export function supersededDiff(foundation: DesignFoundation | undefined, indexTokens: DesignTokenGroup | undefined) {
  return foundationTokenDiff(foundationTokenNames(foundation), flattenDesignTokens(indexTokens).tokens.map((token) => token.path));
}

// ---------------------------------------------------------------------------
// Sample screens
// ---------------------------------------------------------------------------

function node(id: string, primitive: string, props: DesignNode["props"], children: string[] = [], extra: Partial<DesignNode> = {}): DesignNode {
  return { id, component: { primitive }, fidelity: "proposed", props, children, ...extra };
}

const textNode = (id: string, value: string, variant: string): DesignNode =>
  node(id, "text", {}, [], { text: value, variant });

/**
 * The screens the canvas draws for a foundation.
 *
 * Three, because three is what shows a design language: the type scale and
 * the palette as they really render; the core components in their variants
 * and states; and one ordinary screen made out of them, so a person can see
 * whether the thing they just approved is something they want to look at.
 *
 * They are composed only from the kit's primitives and carry fidelity
 * `proposed`, which is exactly what they are — a facsimile of a design system
 * that does not exist yet.
 */
export function foundationSampleScreens(foundation: DesignFoundation | undefined): DesignScreen[] {
  const type = foundation?.typeScale ?? [];
  const components = foundation?.components ?? [];
  const principles = foundation?.principles ?? [];

  const scaleNodes: DesignNode[] = [
    node("sample-type-root", "stack", { gap: { type: "token", tokenId: "space.4" }, padded: { type: "boolean", value: true } }, [
      "sample-type-title",
      ...type.slice(0, 8).map((_step, index) => `sample-type-${String(index)}`),
    ], { variant: "column" }),
    textNode("sample-type-title", "Type scale", "heading"),
    ...type.slice(0, 8).map((step, index) =>
      textNode(`sample-type-${String(index)}`, `${step.name} · ${step.size}${step.usage ? ` — ${step.usage}` : ""}`, index === 0 ? "subheading" : "body"),
    ),
  ];

  const componentIds = components.slice(0, 8).map((_component, index) => `sample-component-${String(index)}`);
  const componentNodes: DesignNode[] = [
    node("sample-components-root", "stack", { gap: { type: "token", tokenId: "space.4" }, padded: { type: "boolean", value: true } }, [
      "sample-components-title",
      ...componentIds,
    ], { variant: "column" }),
    textNode("sample-components-title", "Core components", "heading"),
    ...components.slice(0, 8).flatMap((component, index) => componentSample(`sample-component-${String(index)}`, component)),
  ];

  const screenNodes: DesignNode[] = [
    node("sample-screen-root", "stack", { gap: { type: "token", tokenId: "space.6" }, padded: { type: "boolean", value: true } }, [
      "sample-screen-nav",
      "sample-screen-card",
      "sample-screen-empty",
    ], { variant: "column" }),
    node("sample-screen-nav", "nav", {}, ["sample-screen-nav-1", "sample-screen-nav-2"], { variant: "horizontal" }),
    textNode("sample-screen-nav-1", "Overview", "body"),
    textNode("sample-screen-nav-2", "Settings", "body"),
    node(
      "sample-screen-card",
      "card",
      { title: { type: "text", value: principles[0] ?? "A card, in this product's language" }, subtitle: { type: "text", value: principles[1] ?? "Everything here is a token you can change." } },
      ["sample-screen-input", "sample-screen-actions"],
      { variant: "default" },
    ),
    node("sample-screen-input", "input", { label: { type: "text", value: "What are you looking for?" }, placeholder: { type: "text", value: "Search" } }, []),
    node("sample-screen-actions", "stack", { gap: { type: "token", tokenId: "space.2" } }, ["sample-screen-primary", "sample-screen-secondary"], { variant: "row" }),
    node("sample-screen-primary", "button", { label: { type: "text", value: "Save" } }, [], { variant: "primary" }),
    node("sample-screen-secondary", "button", { label: { type: "text", value: "Cancel" } }, [], { variant: "secondary" }),
    node("sample-screen-empty", "empty", { title: { type: "text", value: "Nothing here yet" }, detail: { type: "text", value: "Every state is designed, including this one." } }, []),
  ];

  return [
    screen("foundation-type", "Type and colour", "sample-type-root", scaleNodes),
    screen("foundation-components", "Components", "sample-components-root", componentNodes),
    screen("foundation-screen", "A screen in this language", "sample-screen-root", screenNodes),
  ];
}

function screen(id: string, name: string, rootNodeId: string, nodes: DesignNode[]): DesignScreen {
  return {
    id,
    name,
    content: { tree: { rootNodeId, nodes } },
    viewport: "laptop",
    states: [{ name: "default", included: true }],
    fidelity: "proposed",
  };
}

/** One component contract, drawn with the kit primitive that matches it. */
function componentSample(id: string, contract: FoundationComponentContract): DesignNode[] {
  const primitive = KIT_FOR_CONTRACT[contract.name.toLowerCase()] ?? "card";
  const variant = contract.variants[0];
  const label = `${contract.name}${variant ? ` · ${variant}` : ""}`;
  switch (primitive) {
    case "button":
      return [node(id, "button", { label: { type: "text", value: label } }, [], variant ? { variant } : {})];
    case "input":
      return [node(id, "input", { label: { type: "text", value: contract.name }, placeholder: { type: "text", value: contract.purpose } }, [])];
    case "select":
      return [node(id, "select", { label: { type: "text", value: contract.name } }, [])];
    case "checkbox":
      return [node(id, "checkbox", { label: { type: "text", value: contract.purpose } }, [])];
    case "toast":
      return [node(id, "toast", { title: { type: "text", value: contract.name }, detail: { type: "text", value: contract.purpose } }, [])];
    case "empty":
      return [node(id, "empty", { title: { type: "text", value: contract.name }, detail: { type: "text", value: contract.purpose } }, [])];
    case "error":
      return [node(id, "error", { title: { type: "text", value: contract.name }, detail: { type: "text", value: contract.purpose } }, [])];
    case "loading":
      return [node(id, "loading", { label: { type: "text", value: contract.purpose } }, [])];
    case "table":
      return [node(id, "table", { density: { type: "choice", value: "comfortable" } }, [])];
    case "nav":
      return [node(id, "nav", {}, [`${id}-item`], { variant: "horizontal" }), textNode(`${id}-item`, contract.name, "body")];
    case "dialog":
      return [
        node(id, "dialog", { title: { type: "text", value: contract.name }, description: { type: "text", value: contract.purpose } }, [`${id}-body`], { variant: "default" }),
        textNode(`${id}-body`, contract.variants.join(" · ") || "default", "body"),
      ];
    default:
      return [
        node(id, "card", { title: { type: "text", value: label }, subtitle: { type: "text", value: contract.purpose } }, [`${id}-states`], { variant: "default" }),
        textNode(`${id}-states`, (contract.states ?? contract.variants).join(" · ") || "default", "caption"),
      ];
  }
}

/** Which kit primitive draws which core contract. */
const KIT_FOR_CONTRACT: Readonly<Record<string, string>> = {
  button: "button",
  input: "input",
  select: "select",
  checkbox: "checkbox",
  card: "card",
  dialog: "dialog",
  toast: "toast",
  nav: "nav",
  table: "table",
  empty: "empty",
  error: "error",
  loading: "loading",
};

/** A body the kit can render: the foundation's samples and nothing else. */
export function foundationSampleBody(foundation: DesignFoundation | undefined, brief: string): DesignBody {
  return {
    brief,
    ...(foundation ? { foundation } : {}),
    screens: foundationSampleScreens(foundation),
    flows: [],
    sketches: [],
    fidelity: "proposed",
    fixtures: [],
  };
}
