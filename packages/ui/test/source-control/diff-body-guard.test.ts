import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the worker pool off and never statically references the worker URL", () => {
  const src = readFileSync(new URL("../../src/source-control/diff-body.tsx", import.meta.url), "utf8");
  expect(src).toMatch(/disableWorkerPool/);
  expect(src).not.toMatch(/worker\/worker/);
  expect(src).not.toMatch(/WorkerPoolContextProvider/);
  expect(src).toMatch(/Virtualizer/);
});

it("loads the overlay renderer through a dynamic import", () => {
  const src = readFileSync(new URL("../../src/source-control/overlay.tsx", import.meta.url), "utf8");
  expect(src).toMatch(/lazy\(\(\) => import\("\.\/diff-body\.js"\)/);
  expect(src).not.toMatch(/@pierre\/diffs/);
});
