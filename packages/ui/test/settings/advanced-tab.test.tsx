// @vitest-environment happy-dom
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/runtime", () => ({
  useCapability: () => ({ state: "available" }),
}));
vi.mock("../../src/components/settings/resources/ResourceDiagnostics.js", () => ({
  ResourceDiagnostics: () => <div data-testid="resources">Resource truth is available</div>,
}));
vi.mock("../../src/components/settings/SettingsForm.js", () => ({
  SettingsForm: () => <label>Remembered field<input aria-label="Remembered field" defaultValue="" /></label>,
}));

import { AdvancedTab, type AdvancedView } from "../../src/components/settings/AdvancedTab.js";
import { click, render } from "./mcp/harness.js";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function Host({ configured = false }: { configured?: boolean }) {
  const [view, setView] = useState<AdvancedView>("resources");
  return <AdvancedTab
    view={view}
    onViewChange={setView}
    scopeView="global"
    {...(configured ? { cwd: "/p", catalog: {} as never, snapshot: {} as never } : {})}
    loading={false}
    onReload={() => {}}
    onApply={async () => true}
  />;
}

it("keeps Resources usable without a selected project", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ root } = await render(<Host />));
  expect(document.querySelector('[role="tabpanel"][aria-label="Resources"]')?.textContent).toContain("Resource truth is available");
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    expect(tab.className).toContain("pointer-coarse:min-h-11");
  }
  await click("Configuration");
  expect(document.body.textContent).toContain("Configuration target unavailable");
  await click("Resources");
  expect(document.body.textContent).toContain("Resource truth is available");
});

it("keeps Configuration mounted so its local form state survives subtab switches", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ root } = await render(<Host configured />));
  await click("Configuration");
  const field = document.querySelector<HTMLInputElement>('[aria-label="Remembered field"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, "kept");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Resources");
  expect(field.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);
  await click("Configuration");
  expect(document.querySelector<HTMLInputElement>('[aria-label="Remembered field"]')?.value).toBe("kept");
});
