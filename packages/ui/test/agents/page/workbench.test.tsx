// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkbenchProvider, useWorkbench, type WorkbenchState } from "../../../src/components/workbench/index.js";

let container: HTMLDivElement;
let root: Root;
let latest: WorkbenchState | undefined;

function Probe() {
  latest = useWorkbench();
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  latest = undefined;
});

describe("workbench.open", () => {
  it("keeps the settings form and adds the agents deep link beside it", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    expect(latest?.page).toBeNull();
    await act(async () => latest!.open("settings", "models"));
    expect(latest?.page).toBe("settings");
    expect(latest?.tab).toBe("models");
    expect(latest?.agents).toBeUndefined();

    await act(async () => latest!.open("agents", { agent: "reviewer", field: "skills" }));
    expect(latest?.page).toBe("agents");
    expect(latest?.agents).toEqual({ agent: "reviewer", field: "skills" });
    expect(latest?.tab).toBeUndefined();

    // The same request twice is two objects, so a screen can re-run the scroll.
    const first = latest?.agents;
    await act(async () => latest!.open("agents", { agent: "reviewer", field: "skills" }));
    expect(latest?.agents).toEqual(first);
    expect(latest?.agents).not.toBe(first);

    await act(async () => latest!.open("agents"));
    expect(latest?.agents).toBeUndefined();
    await act(async () => latest!.open("logs"));
    expect(latest?.page).toBe("logs");
    await act(async () => latest!.close());
    expect(latest?.page).toBeNull();
  });
});
