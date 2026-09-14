// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Chart } from "../../src/components/assistant-ui/elements/chart.js";

let root: Root | undefined;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

it("breaks line and area segments at unavailable samples and describes the gap", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <Chart
      label="Physical memory"
      value="30 MB"
      points={[null, 10, 20, null, 25, 30, undefined]}
      pointLabel={(value, index) => `sample ${index + 1}: ${value} MB`}
      unavailableLabel={(index) => `sample ${index + 1}: unavailable`}
    />,
  ));
  expect(container.querySelectorAll("[data-chart-segment]")).toHaveLength(2);
  expect(container.querySelectorAll("polyline")).toHaveLength(2);
  expect(container.querySelectorAll("path")).toHaveLength(2);
  expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("sample 7: unavailable");
});

it("keeps existing numeric series as one continuous segment", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Chart label="Tokens" value="3" points={[1, 2, 3]} />));
  expect(container.querySelectorAll("[data-chart-segment]")).toHaveLength(1);
  expect(container.querySelectorAll("polyline")).toHaveLength(1);
});
