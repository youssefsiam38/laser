// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PRODUCT_VERSION } from "@lasercode/protocol";
vi.mock("../../src/runtime/index.js", () => ({ useLaserStable: vi.fn(), useLaserState: vi.fn() }));
import { VersionNotice } from "../../src/components/assistant-ui/elements/connection-state.js";
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); });
function render(props: Parameters<typeof VersionNotice>[0]) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); act(() => root.render(<VersionNotice {...props} />));
  cleanups.push(() => { act(() => root.unmount()); node.remove(); }); return node;
}
it("only refreshes the browser when the person chooses; promises no host interruption", () => {
  const refresh = vi.fn(), restart = vi.fn();
  const node = render({ hostVersion: "99.0.0", onRefresh: refresh, onRestart: restart });
  expect(node.textContent).toContain("sessions and running agents will not be affected");
  expect(refresh).not.toHaveBeenCalled();
  act(() => node.querySelector("button")!.click());
  expect(refresh).toHaveBeenCalledOnce(); expect(restart).not.toHaveBeenCalled();
});
it("distinguishes a full local restart and warns about stopping active work", () => {
  const restart = vi.fn(), refresh = vi.fn();
  const node = render({ desktopVersion: PRODUCT_VERSION, installedVersion: "99.0.0", onRefresh: refresh, onRestart: restart });
  expect(node.textContent).toContain("active work will stop");
  expect(restart).not.toHaveBeenCalled();
  act(() => node.querySelector("button")!.click());
  expect(restart).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled();
});

// The action out of a view that is blocked until it is taken has to be
// reachable with a thumb; the browser matrix measured its sibling at 28px.
it("gives both actions a coarse-pointer target", () => {
  for (const props of [
    { hostVersion: "99.0.0", onRefresh: vi.fn(), onRestart: vi.fn() },
    { desktopVersion: PRODUCT_VERSION, installedVersion: "99.0.0", onRefresh: vi.fn(), onRestart: vi.fn() },
  ]) {
    const button = render(props).querySelector("button")!;
    expect(button.className, button.textContent ?? "").toContain("pointer-coarse:min-h-11");
  }
});
