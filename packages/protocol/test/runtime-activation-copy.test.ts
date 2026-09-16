import { describe, expect, it } from "vitest";
import { runtimeUpdatePresentation } from "../src/runtime-activation-copy.js";

describe("runtime update presentation", () => {
  it("keeps migration preparation, failure and restoration copy exact", () => {
    expect(runtimeUpdatePresentation("preparing-data")).toEqual({
      title: "Preparing your data for this update…",
      detail: "Your current data snapshot is being verified before anything changes.",
      action: "none",
    });
    expect(runtimeUpdatePresentation("migration-failed")).toEqual({
      title: "The update could not be finished.",
      detail: "Your previous data snapshot is intact.",
      action: "prepare",
      actionLabel: "Try again",
      secondaryAction: "restore",
      secondaryActionLabel: "Restore previous data",
    });
    expect(runtimeUpdatePresentation("restored")).toMatchObject({
      title: "Previous data restored. The update was not activated.",
      action: "prepare",
    });
    expect(runtimeUpdatePresentation("no-snapshot")).toMatchObject({
      detail: "There is no earlier data snapshot to restore.",
      action: "retry",
    });
  });
});
