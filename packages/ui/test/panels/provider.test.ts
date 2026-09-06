import type { Panel } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";

import { isTranscriptOnlyPanel } from "../../src/panels/PanelsProvider.js";

const collection = (source: string): Panel => ({
  v: 1,
  id: "results",
  kind: "collection",
  intent: "inline",
  source,
  title: "Results",
  data: { items: [], layout: "list" },
});

describe("transcript-owned panels", () => {
  it("suppresses the retired pi-web-access duplicate and no other collection", () => {
    expect(isTranscriptOnlyPanel(collection("pi-web-access"))).toBe(true);
    expect(isTranscriptOnlyPanel(collection("another-extension"))).toBe(false);
  });
});
