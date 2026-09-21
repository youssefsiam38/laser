// @vitest-environment happy-dom
/**
 * The tree frame: a Shadow DOM root skinned by the index (M21-T11, D-354).
 *
 * What is asserted is the boundary itself: the project's tokens are custom
 * properties on the root *inside* the shadow, the kit stylesheet is inside it
 * too, every node is real DOM with its stable id, and the kit draws a node's
 * fidelity and review state as data the inspector and a comment can find.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TreeFrame } from "../../src/components/design/TreeFrame.js";
import type { KitRenderContext } from "../../src/components/design/kit/KitNode.js";
import { frameTokens } from "../../src/design/tokens.js";
import { screenOf } from "../../src/design/tree-model.js";

import { designFixture, tokensDocument } from "./fixture.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function context(over: Partial<KitRenderContext> = {}): KitRenderContext {
  const body = designFixture();
  return { body, screen: screenOf(body, "scr_list")!, mode: "edit", nodeStates: {}, nodeVariants: {}, ...over };
}

const shadow = (): ShadowRoot => {
  const host = container.querySelector<HTMLElement>('[data-slot="design-tree-frame"]');
  expect(host?.shadowRoot ?? null).not.toBeNull();
  return host!.shadowRoot!;
};

describe("TreeFrame", () => {
  it("sets the index's tokens as custom properties on the root inside the shadow, with the kit stylesheet beside it", async () => {
    const tokens = frameTokens(tokensDocument());
    await act(async () => root.render(<TreeFrame context={context()} tokenProperties={tokens.properties} width={800} height={600} label="Invoices" />));
    const sr = shadow();
    const kitRoot = sr.querySelector<HTMLElement>('[data-design-root="true"]');
    expect(kitRoot).not.toBeNull();
    expect(kitRoot!.style.getPropertyValue("--design-color-brand-500")).toBe("#1f2937");
    expect(kitRoot!.style.getPropertyValue("--design-space-unit")).toBe("4px");
    expect(kitRoot!.dataset["tokenCount"]).toBe(String(tokens.tokens.length));
    // The tokens never land outside the shadow.
    expect(container.querySelector<HTMLElement>('[data-slot="design-tree-frame"]')!.style.getPropertyValue("--design-color-brand-500")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--design-color-brand-500")).toBe("");
    const style = sr.querySelector("style");
    expect(style?.textContent).toContain(".kit-button");
    expect(style?.textContent).toContain("var(--design-color-action-base, var(--live))");
  });

  it("draws every node as real DOM carrying its stable id, fidelity and review state", async () => {
    await act(async () => root.render(<TreeFrame context={context()} tokenProperties={{}} width={800} height={600} label="Invoices" />));
    const sr = shadow();
    const ids = [...sr.querySelectorAll<HTMLElement>("[data-node-id]")].map((element) => element.dataset["nodeId"]);
    expect(ids).toEqual(["n_root", "n_title", "n_table", "n_actions", "n_pay", "n_help"]);
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_help"]')?.dataset["unreviewed"]).toBe("true");
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_pay"]')?.dataset["fidelity"]).toBe("mapped");
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_pay"]')?.tagName).toBe("BUTTON");
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_pay"]')?.className).toContain("kit-button--primary");
    // The table binds to its fixture and shows generated rows, not lorem ipsum.
    expect(sr.querySelectorAll('[data-node-id="n_table"] tbody tr')).toHaveLength(4);
    // The root's own text is escaped text, never markup.
    expect(sr.querySelector('[data-node-id="n_title"]')?.textContent).toBe("Invoices");
  });

  it("selects on click in edit mode, marks the selection, and commits an inline text edit", async () => {
    const onSelect = vi.fn();
    const onBeginTextEdit = vi.fn();
    const onCommitText = vi.fn();
    await act(async () =>
      root.render(<TreeFrame context={context({ onSelect, onBeginTextEdit, onCommitText, selectedNodeId: "n_title" })} tokenProperties={{}} width={800} height={600} label="Invoices" />),
    );
    const sr = shadow();
    const title = sr.querySelector<HTMLElement>('[data-node-id="n_title"]')!;
    expect(title.className).toContain("kit-selected");
    await act(async () => sr.querySelector<HTMLElement>('[data-node-id="n_pay"]')!.click());
    expect(onSelect).toHaveBeenCalledWith("n_pay");
    await act(async () => title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onBeginTextEdit).toHaveBeenCalledWith("n_title");

    await act(async () =>
      root.render(
        <TreeFrame context={context({ onSelect, onBeginTextEdit, onCommitText, selectedNodeId: "n_title", editingNodeId: "n_title" })} tokenProperties={{}} width={800} height={600} label="Invoices" />,
      ),
    );
    const editor = shadow().querySelector<HTMLElement>('[data-editing="true"]')!;
    expect(editor.getAttribute("contenteditable")).toBe("true");
    editor.textContent = "Your invoices";
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onCommitText).toHaveBeenCalledWith("n_title", "Your invoices");
  });

  it("plays a wired node in prototype mode and never selects", async () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    await act(async () => root.render(<TreeFrame context={context({ mode: "prototype", onSelect, onActivate })} tokenProperties={{}} width={800} height={600} label="Invoices" />));
    const sr = shadow();
    const pay = sr.querySelector<HTMLElement>('[data-node-id="n_pay"]')!;
    expect(pay.dataset["interactive"]).toBe("true");
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_table"]')!.dataset["interactive"]).toBeUndefined();
    await act(async () => pay.click());
    expect(onActivate).toHaveBeenCalledWith("n_pay", "click");
    expect(onSelect).not.toHaveBeenCalled();
    expect(sr.querySelector("[draggable]")).toBeNull();
  });

  it("reflects a prototype's state and variant on the node, and a commented node", async () => {
    await act(async () =>
      root.render(
        <TreeFrame
          context={context({ mode: "read", nodeStates: { n_table: "loading" }, nodeVariants: { n_pay: "ghost" }, commentedNodeIds: new Set(["n_title"]) })}
          tokenProperties={{}}
          width={800}
          height={600}
          label="Invoices"
        />,
      ),
    );
    const sr = shadow();
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_table"]')!.dataset["state"]).toBe("loading");
    expect(sr.querySelector('[data-node-id="n_table"]')?.textContent).toContain("Loading");
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_pay"]')!.className).toContain("kit-button--ghost");
    expect(sr.querySelector<HTMLElement>('[data-node-id="n_title"]')!.dataset["commented"]).toBe("true");
  });

  it("draws an index entry with the closest kit primitive and never invents a component", async () => {
    const entries = new Map([["e_help", { id: "e_help", name: "HelpLink", reviewed: false }]]);
    await act(async () => root.render(<TreeFrame context={context({ entries })} tokenProperties={{}} width={800} height={600} label="Invoices" />));
    const help = shadow().querySelector<HTMLElement>('[data-node-id="n_help"]')!;
    expect(help.dataset["primitive"]).toBe("button");
    expect(help.dataset["entry"]).toBe("e_help");
    expect(help.dataset["unreviewed"]).toBe("true");
  });
});
