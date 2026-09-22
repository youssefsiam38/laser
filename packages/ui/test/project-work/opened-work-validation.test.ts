import { describe, expect, it } from "vitest";
import { planBodySchema } from "@lasercode/protocol";

import { workFieldError } from "../../src/components/project-work/opened-work-validation.js";
import { firstBody } from "../../src/project-work/store.js";

describe("opened work validation units", () => {
  it("reports the actual schema's array bound in entries, not characters", () => {
    const body = firstBody("plan", "Deliver the change");
    if (body.kind !== "plan") throw new Error("Expected a Plan fixture");
    const result = planBodySchema.safeParse({ ...body.plan, verification: Array.from({ length: 65 }, () => "pnpm test") });
    if (result.success) throw new Error("Expected the schema to reject too many checks");
    expect(workFieldError("plan", result.error.issues[0])?.message).toBe("Verification command can have at most 64 entries.");
  });

  it("keeps a string bound in characters", () => {
    const body = firstBody("plan", "Deliver the change");
    if (body.kind !== "plan") throw new Error("Expected a Plan fixture");
    const result = planBodySchema.safeParse({ ...body.plan, verification: ["x".repeat(501)] });
    if (result.success) throw new Error("Expected the schema to reject an oversized check");
    expect(workFieldError("plan", result.error.issues[0])?.message).toBe("Verification command 1 must be 500 characters or fewer.");
  });
});
