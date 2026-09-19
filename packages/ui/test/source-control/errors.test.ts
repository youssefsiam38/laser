import { expect, it, vi } from "vitest";
import { CHANGES_LIST_FAILED, isPersonFacingSentence, personFacingChangesError } from "../../src/source-control/errors.js";

it("keeps a sentence and replaces a stack", () => {
  expect(isPersonFacingSentence("That revision is not in this repository.")).toBe(true);
  expect(isPersonFacingSentence("TypeError: Cannot read properties of undefined")).toBe(false);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(personFacingChangesError(new Error("ENOENT: no such file"), CHANGES_LIST_FAILED)).toBe(CHANGES_LIST_FAILED);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
  expect(personFacingChangesError(new Error("Could not read this repository."), CHANGES_LIST_FAILED)).toBe(
    "Could not read this repository.",
  );
});
