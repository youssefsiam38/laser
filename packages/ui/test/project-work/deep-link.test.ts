import { afterEach, describe, expect, it } from "vitest";
import { URL_SCHEME_PREFIX } from "@lasercode/protocol";

import { formatWorkLinkHash, parseWorkLink, sameWorkLink, workLinkUrl } from "../../src/project-work/deep-link.js";
import { landWorkLink, resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";

const target = { projectId: "p1", kind: "spec" as const, entityId: "e7", revisionId: "r3" };

afterEach(() => resetWorkspaceUi());

describe("a link into the workspace", () => {
  it("carries the whole identity: project, kind, entity and the exact revision", () => {
    expect(formatWorkLinkHash(target)).toBe("#/work/p1/spec/e7/r3");
    expect(workLinkUrl(target)).toBe(`${URL_SCHEME_PREFIX}work/p1/spec/e7/r3`);
    expect(parseWorkLink(formatWorkLinkHash(target))).toEqual(target);
    expect(parseWorkLink(workLinkUrl(target))).toEqual(target);
  });

  it("round-trips through a whole page URL, and through the project alone", () => {
    expect(parseWorkLink("https://example.test/?x=1#/work/p1/task/e2")).toEqual({ projectId: "p1", kind: "task", entityId: "e2" });
    expect(parseWorkLink("#/work/p1")).toEqual({ projectId: "p1" });
    expect(formatWorkLinkHash({ projectId: "p1" })).toBe("#/work/p1");
  });

  it("encodes and decodes ids without losing them", () => {
    const awkward = { projectId: "p/1", kind: "design" as const, entityId: "e 7", revisionId: "r#3" };
    expect(parseWorkLink(formatWorkLinkHash(awkward))).toEqual(awkward);
  });

  it("repairs nothing: a half link is not a link", () => {
    expect(parseWorkLink("#/session/%2Fp%2Fs.jsonl")).toBeUndefined();
    expect(parseWorkLink("#/work")).toBeUndefined();
    expect(parseWorkLink("#/work/p1/notakind/e1")).toBeUndefined();
    expect(parseWorkLink("#/work/p1/spec")).toBeUndefined();
    expect(parseWorkLink(`${URL_SCHEME_PREFIX}open/settings`)).toBeUndefined();
    expect(parseWorkLink("")).toBeUndefined();
  });

  it("compares two links by every part, the revision included", () => {
    expect(sameWorkLink(target, { ...target })).toBe(true);
    expect(sameWorkLink(target, { ...target, revisionId: "r4" })).toBe(false);
    expect(sameWorkLink(undefined, undefined)).toBe(true);
    expect(sameWorkLink(target, undefined)).toBe(false);
  });

  it("lands on that exact revision, and says the person arrived from a link", () => {
    landWorkLink(target);
    const ui = workspaceUi();
    expect(ui.open).toBe(true);
    expect(ui.projectId).toBe("p1");
    expect(ui.selection).toEqual({ entityId: "e7", kind: "spec", revisionId: "r3", fromLink: true });
  });

  it("a project-only link opens the backlog rather than guessing an entity", () => {
    landWorkLink({ projectId: "p1" });
    expect(workspaceUi()).toMatchObject({ open: true, projectId: "p1", tab: "work", selection: undefined });
  });
});
