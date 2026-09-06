import { expect, it } from "vitest";
import { hostNeedsRefresh } from "../src/host-compatibility.js";

it("refreshes every service generation except the bundled one", () => {
  expect(hostNeedsRefresh("0.2.5", "0.2.5")).toBe(false);
  expect(hostNeedsRefresh("0.2.0", "0.2.5")).toBe(true);
  expect(hostNeedsRefresh("0.2.6", "0.2.5")).toBe(true);
  expect(hostNeedsRefresh("unknown", "0.2.5")).toBe(true);
});
