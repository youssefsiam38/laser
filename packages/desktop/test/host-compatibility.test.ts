import { expect, it } from "vitest";
import { hostVersionProblem } from "../src/host-compatibility.js";

it("only adopts an exactly matching service generation", () => {
  expect(hostVersionProblem("0.2.5", "0.2.5")).toBeUndefined();
  expect(hostVersionProblem("0.2.0", "0.2.5")).toContain("still running version 0.2.0");
  expect(hostVersionProblem("0.2.6", "0.2.5")).toContain("Finish any active work");
  expect(hostVersionProblem("unknown", "0.2.5")).toContain("saved chats");
});
