// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LinkDestination } from "../../src/components/shell/LinkDestination.js";

let root: Root, container: HTMLDivElement, link: HTMLAnchorElement;
const preview = () => document.querySelector('[data-slot="link-destination"]');
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  link = document.createElement("a"); link.href = "https://example.com/a%20b?q=1#section";
  link.innerHTML = "<span>Read more</span>"; document.body.append(link);
  await act(async () => root.render(<LinkDestination />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); link.remove(); });
it("previews nested links outside the root without changing their destination or blocking clicks", async () => {
  await act(async () => link.firstChild!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  expect(preview()?.textContent).toBe(link.href);
  expect(preview()?.className).toContain("pointer-events-none");
  expect(preview()?.getAttribute("dir")).toBe("ltr");
  await act(async () => link.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
  expect(preview()).toBeNull();
});
it("supports keyboard focus and clears on scrolling or window blur", async () => {
  await act(async () => link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(preview()).not.toBeNull();
  await act(async () => document.dispatchEvent(new Event("scroll")));
  expect(preview()).toBeNull();
  await act(async () => link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(preview()).toBeNull();
});
it("shows an editor path verbatim instead of resolving it against the web origin", async () => {
  link.setAttribute("data-file-path", "/project/src/index.ts");
  await act(async () => link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(preview()?.textContent).toBe("/project/src/index.ts");
  await act(async () => { link.setAttribute("data-file-path", "/other/source.ts"); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(preview()?.textContent).toBe("/other/source.ts");
  await act(async () => { link.setAttribute("inert", ""); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(preview()).toBeNull();
});
it("ignores touch, unsafe schemes and inert links", async () => {
  await act(async () => link.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "touch" })));
  expect(preview()).toBeNull();
  link.href = "javascript:alert(1)";
  await act(async () => link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(preview()).toBeNull();
  link.href = "https://example.com"; link.setAttribute("inert", "");
  await act(async () => link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(preview()).toBeNull();
});
it("removes credentials, updates changed destinations and clears a removed link", async () => {
  link.href = "https://user:secret@example.com/path";
  await act(async () => link.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(preview()?.textContent).toBe("https://example.com/path");
  await act(async () => { link.href = "https://example.org/new"; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(preview()?.textContent).toBe("https://example.org/new");
  await act(async () => { link.remove(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(preview()).toBeNull();
});
