// @vitest-environment happy-dom
/**
 * The node inspector (M21-T11, `docs/design-phase.md` Case B).
 *
 * The one rule that makes a design *composed* rather than styled: a token
 * field takes only a token the index has, and a free value is refused with
 * the nearest token suggested — one press applies it. Plus the edits the
 * inspector owns (text, variant, state, order) and the index entry's evidence
 * for a Mapped node.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignBody } from "@lasercode/protocol";

import { NodeInspector } from "../../src/components/design/NodeInspector.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { frameTokens } from "../../src/design/tokens.js";
import { nodeOf, screenOf, treeOf } from "../../src/design/tree-model.js";

import { designFixture, indexFixture, tokensDocument } from "./fixture.js";

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

const byLabel = <T extends HTMLElement = HTMLElement>(label: string): T => {
  const element = container.querySelector<T>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
};

function setValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function mount(body: DesignBody, nodeId: string, onChange: (body: DesignBody) => void, editable = true) {
  const screen = screenOf(body, "scr_list")!;
  const node = nodeOf(screen, nodeId)!;
  const index = indexFixture();
  return root.render(
    <TooltipProvider>
      <NodeInspector
        body={body}
        screen={screen}
        node={node}
        tokens={frameTokens(tokensDocument()).tokens}
        entry={"indexEntryId" in node.component ? index.entries.find((entry) => entry.id === node.component.indexEntryId) : undefined}
        editable={editable}
        readOnlyReason={editable ? undefined : "Editing is disabled on an older revision."}
        onChange={onChange}
      />
    </TooltipProvider>,
  );
}

describe("NodeInspector", () => {
  it("refuses a free colour with the nearest token suggested, and applies it on one press", async () => {
    const onChange = vi.fn();
    await act(async () => mount(designFixture(), "n_title", onChange));
    const colour = byLabel<HTMLInputElement>("Colour");
    await act(async () => setValue(colour, "#1f2938"));
    await act(async () => colour.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const refusal = container.querySelector<HTMLElement>('[data-slot="free-value-refusal"]');
    expect(refusal).not.toBeNull();
    expect(refusal!.getAttribute("role")).toBe("alert");
    expect(refusal!.textContent).toContain("design system has no value like that");
    expect(onChange).not.toHaveBeenCalled();
    const use = [...refusal!.querySelectorAll("button")].find((button) => button.textContent?.includes("Use color.brand.500"));
    expect(use).toBeDefined();
    await act(async () => use!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as DesignBody;
    expect(nodeOf(screenOf(next, "scr_list"), "n_title")?.props["color"]).toEqual({ type: "token", tokenId: "color.brand.500" });
    expect(container.querySelector('[data-slot="free-value-refusal"]')).toBeNull();
  });

  it("takes a token the index has, and refuses one it does not without inventing a suggestion", async () => {
    const onChange = vi.fn();
    await act(async () => mount(designFixture(), "n_title", onChange));
    const colour = byLabel<HTMLInputElement>("Colour");
    await act(async () => setValue(colour, "color.ink.muted"));
    await act(async () => colour.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0]?.[0] as DesignBody).screens[0]).toBeDefined();
    await act(async () => setValue(colour, "totally-not-a-token-anywhere"));
    await act(async () => colour.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-slot="free-value-refusal"]')?.textContent).toContain("Pick a token from the list");
  });

  it("edits text, variant, state and order through the model, never mutating the body", async () => {
    const body = designFixture();
    const seen: DesignBody[] = [];
    await act(async () => mount(body, "n_pay", (next) => seen.push(next)));
    await act(async () => setValue(byLabel<HTMLTextAreaElement>("Text"), "Pay this invoice"));
    await act(async () => setValue(byLabel<HTMLSelectElement>("Variant"), "ghost"));
    await act(async () => setValue(byLabel<HTMLSelectElement>("State"), "loading"));
    const later = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Later"));
    await act(async () => later!.click());
    expect(seen).toHaveLength(4);
    expect(nodeOf(screenOf(seen[0]!, "scr_list"), "n_pay")?.text).toBe("Pay this invoice");
    expect(nodeOf(screenOf(seen[1]!, "scr_list"), "n_pay")?.variant).toBe("ghost");
    expect(nodeOf(screenOf(seen[2]!, "scr_list"), "n_pay")?.state).toBe("loading");
    expect(treeOf(screenOf(seen[3]!, "scr_list"))?.nodes.find((n) => n.id === "n_actions")?.children).toEqual(["n_help", "n_pay"]);
    // The body the inspector was given is untouched.
    expect(nodeOf(screenOf(body, "scr_list"), "n_pay")?.text).toBe("Pay now");
  });

  it("shows the index entry, its confidence, its review state and its sources for a Mapped node", async () => {
    await act(async () => mount(designFixture(), "n_help", vi.fn()));
    const entry = container.querySelector('[aria-label="Index entry"]');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain("observed");
    expect(entry!.textContent).toContain("Unreviewed");
    expect(entry!.textContent).toContain("src/components/HelpLink.tsx");
    expect(entry!.querySelector('[aria-label="Open src/components/HelpLink.tsx"]')).not.toBeNull();
    expect(container.textContent).toContain("HelpLink");
    expect([...container.querySelectorAll('[data-slot="badge"]')].some((badge) => badge.textContent === "unreviewed")).toBe(true);
  });

  it("disables every control on a read-only revision and says why", async () => {
    await act(async () => mount(designFixture(), "n_pay", vi.fn(), false));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("older revision");
    expect(byLabel<HTMLTextAreaElement>("Text").disabled).toBe(true);
    expect(byLabel<HTMLSelectElement>("Variant").disabled).toBe(true);
    expect([...container.querySelectorAll("button")].filter((button) => /Earlier|Later/.test(button.textContent ?? "")).every((button) => button.disabled)).toBe(true);
  });
});
