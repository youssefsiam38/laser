import { expect, it } from "vitest";
import { clientParamsSchemas, environmentOverlay, type WorkerNotifications } from "../src/index.js";

it("round-trips the private notification without admitting malformed or unbounded environments", () => {
  const notification: WorkerNotifications["pi/host/environment"] = { variables: { SYNTHETIC_EXPORT: "fixture\nwith=equals" } };
  const schema = clientParamsSchemas["pi/host/environment"];
  expect(schema.parse(JSON.parse(JSON.stringify(notification)))).toEqual(notification);
  for (const variables of [
    { "BAD=NAME": "value" }, { VALID: "null\0value" }, { VALID: 7 },
    { VALID: "x".repeat(131_073) }, Object.fromEntries(Array.from({ length: 4097 }, (_, n) => [`KEY_${n}`, "x"])),
  ]) expect(schema.safeParse({ variables }).success).toBe(false);
  expect(environmentOverlay({ OMITTED: undefined, "BAD=NAME": "no", NULL: "no\0", VALID: "yes" })).toEqual({ VALID: "yes" });
});
