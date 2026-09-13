import { expect, it } from "vitest";
import { matchProjectMention, parentProjectQuery, replaceProjectQuery, resolveProjectPath } from "../../src/components/thread/project-path.js";
import { explorerItems, explorerNavigation } from "../../src/components/thread/project-explorer-model.js";

it.each([
  ["@", "/project", "", ""], ["@/", "/project", "", ""], ["@./", "/project", "", "./"],
  ["@node", "/project", "node", ""], ["@./node", "/project", "node", "./"],
  ["@server/", "/project/server", "", "server/"], ["@server/ind", "/project/server", "ind", "server/"],
  ["@a/b/c", "/project/a/b", "c", "a/b/"], ["@server\\ind", "/project/server", "ind", "server/"],
  ["@a/../server/", "/project/server", "", "a/../server/"], ["@/project/server/ind", "/project/server", "ind", "server/"],
])("resolves %s", (query, directory, prefix, head) => {
  expect(resolveProjectPath(query, "/project")).toEqual({ directory, prefix, head });
});
it.each(["@..", "@../", "@a/../../", "@~", "@~/code", "@/elsewhere/file", "@C:\\elsewhere", "@server/ "])("refuses %s deliberately", (query) => {
  expect(resolveProjectPath(query, "/project").error).toBeTruthy();
});
it("resolves hand-typed Windows separators against a Windows project", () => {
  expect(resolveProjectPath("@C:\\code\\server\\ind", "C:\\code")).toEqual({ directory: "C:/code/server", prefix: "ind", head: "server/" });
});
it("preserves surrounding text and closes at trailing whitespace", () => {
  expect(matchProjectMention("Read @server/ind then", "@", 16)).toMatchObject({ query: "server/ind" });
  expect(matchProjectMention("@server/ ", "@", 9)).toBeNull();
  expect(replaceProjectQuery("Read @ser then", 9, "server/")).toEqual({ text: "Read @server/ then", caret: 13 });
  expect(parentProjectQuery("a/b/")).toBe("a/");
  expect(parentProjectQuery("server/")).toBe("");
  expect(parentProjectQuery("./server/")).toBe("./");
});
it("projects a bounded host page without reordering, inserting directory directives, or losing chip identities", () => {
  const items = explorerItems([
    { name: "server", path: "/project/server", project: false, kind: "directory" },
    { name: "a.txt", path: "/project/a.txt", project: false, kind: "file" },
  ], "/project");
  expect(items.map((item) => [item.id, item.type])).toEqual([["server", "directory"], ["a.txt", "file"]]);
  const nav = explorerNavigation({ head: "", commonPrefix: "", loading: false });
  expect(nav.select(items[0]!, "@ser", 4)).toEqual({ text: "@server/", caret: 8 });
  expect(nav.select(items[1]!, "@a", 2)).toBeNull(); // the primitive owns file directive insertion
  expect(nav.key("Backspace", items, items[0], "@server/", 8)).toEqual({ text: "@", caret: 1 });
});
it("Tab completes the host-wide prefix, not the selected or locally loaded row", () => {
  const items = explorerItems([{ name: "node-one", path: "/project/node-one", project: false, kind: "directory" }], "/project");
  const nav = explorerNavigation({ head: "", commonPrefix: "node-", loading: false });
  expect(nav.key("Tab", items, items[0], "@no", 3)).toEqual({ text: "@node-", caret: 6 });
  const stale = explorerNavigation({ query: "no", head: "", commonPrefix: "node-", loading: false });
  expect(stale.key("Tab", items, items[0], "@server/", 8)).toEqual({ text: "@server/", caret: 8 });
});
