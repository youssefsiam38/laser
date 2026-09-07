// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuotaBanner } from "../../src/components/assistant-ui/elements/quota-banner.js";

it("distinguishes independent allowance buckets with the same duration", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<>
    <QuotaBanner bucketLabel="Codex" label="Weekly allowance" usedPercent={25} resetsLabel="Resets tomorrow" />
    <QuotaBanner bucketLabel="GPT-5.3-Codex-Spark" label="Weekly allowance" usedPercent={10} resetsLabel="Resets Friday" />
  </>);
  expect(container.querySelector('[aria-label="Codex · Weekly allowance remaining"]')?.getAttribute("aria-valuenow")).toBe("75");
  expect(container.querySelector('[aria-label="GPT-5.3-Codex-Spark · Weekly allowance remaining"]')?.getAttribute("aria-valuenow")).toBe("90");
  expect(container.querySelector('[title="GPT-5.3-Codex-Spark"]')?.textContent).toBe("GPT-5.3-Codex-Spark");
});
