import { expect, it } from "vitest";
import { matchProjectMention, parentProjectQuery, replaceProjectQuery, resolveProjectPath } from "../../src/components/thread/project-path.js";
import { explorerItems, explorerNavigation, explorerPageItem, mentionItemId, mentionFormatter, quotedMentionPath } from "../../src/components/thread/project-explorer-model.js";

it.each([
  ["@", ".", "", ""], ["@/", "/", "", "/"], ["@./", ".", "", "./"],
  ["@node", ".", "node", ""], ["@./node", ".", "node", "./"],
  ["@server/", "server", "", "server/"], ["@server/ind", "server", "ind", "server/"],
  ["@a/b/c", "a/b", "c", "a/b/"], ["@server\\ind", "server", "ind", "server/"],
  ["@a/../server/", "a/../server", "", "a/../server/"], ["@/project/server/ind", "/project/server", "ind", "/project/server/"],
  ["@..", "..", "", "../"], ["@../", "..", "", "../"], ["@a/../../", "a/../..", "", "a/../../"],
  ["@../sibling/", "../sibling", "", "../sibling/"], ["@/elsewhere/file", "/elsewhere", "file", "/elsewhere/"],
  ["@C:\\elsewhere", "C:/", "elsewhere", "C:/"], ["@C:/elsewhere", "C:/", "elsewhere", "C:/"],
  ["@~", "~", "", "~/"], ["@~/code", "~", "code", "~/"],
  ["@%USERPROFILE%", "%USERPROFILE%", "", "%USERPROFILE%/"], ["@%USERPROFILE%\\code", "%USERPROFILE%", "code", "%USERPROFILE%/"],
])("splits %s for host resolution", (query, directory, prefix, head) => {
  expect(resolveProjectPath(query)).toEqual({ ok: true, directory, prefix, head });
});
it.each(["@C:relative", "@server/ "])("refuses malformed %s deliberately", (query) => {
  expect(resolveProjectPath(query)).toMatchObject({ ok: false, error: expect.any(String) });
});
it("preserves surrounding text, reads quoted paths, and closes at trailing whitespace", () => {
  expect(matchProjectMention("Read @server/ind then", "@", 16)).toMatchObject({ query: "server/ind" });
  expect(matchProjectMention('@"my folder/"', "@", 13)).toMatchObject({ query: "my folder/" });
  expect(matchProjectMention("@server/ ", "@", 9)).toBeNull();
  expect(matchProjectMention('@"my folder/" ', "@", 14)).toBeNull();
  expect(replaceProjectQuery("Read @ser then", 9, "server/")).toEqual({ text: "Read @server/ then", caret: 13 });
  expect(replaceProjectQuery('@"my folder/sub/"', 17, "my folder/")).toEqual({ text: '@"my folder/"', caret: 13 });
});
it.each([
  ["a/b/", "a/"], ["server/", ""], ["./server/", "./"], ["../", "../../"],
  ["..\\sibling\\", "../"], ["~/server/", "~/"], ["%USERPROFILE%/server/", "%USERPROFILE%/"],
  ["/sibling/", "/"], ["C:\\code\\server\\", "C:/code/"],
])("backs up from %s to %s", (query, parent) => expect(parentProjectQuery(query)).toBe(parent));
it.each(["/", "C:/", "//server/share/", "~/", "%USERPROFILE%/"])("leaves root deletion to the input at %s", query => {
  expect(parentProjectQuery(query)).toBeNull();
  const nav = explorerNavigation({ cwd: "/project", query, head: query, commonPrefix: "", loading: false, next: undefined, previous: undefined });
  expect(nav.key("Backspace", [], undefined, "@" + query, query.length + 1)).toBeNull();
});
it("projects canonical host paths and marks folders with a trailing slash", () => {
  const items = explorerItems([
    { name: "server", path: "/project/server", project: false, kind: "directory" },
    { name: "a.txt", path: "/project/a.txt", project: false, kind: "file" },
    { name: "outside.txt", path: "C:\\Users\\me\\outside.txt", project: false, kind: "file" },
  ], "/project");
  expect(items.map((item) => [item.metadata?.identity, item.type])).toEqual([["/project/server/", "directory"], ["/project/a.txt", "file"], ["C:/Users/me/outside.txt", "file"]]);
  expect(items.map(item => mentionFormatter.serialize(item))).toEqual(["@server/", "@a.txt", "@C:/Users/me/outside.txt"]);
  expect(mentionFormatter.parse(mentionFormatter.serialize(items[0]!))).toEqual([{ kind: "mention", type: "directory", id: "server/", label: "server/" }]);
  const nav = explorerNavigation({ cwd: "/project", query: "ser", head: "", commonPrefix: "", loading: false, next: undefined, previous: undefined });
  expect(nav.select(items[0]!, "@ser", 4)).toBeNull(); // Enter/click belongs to the directive and inserts the folder.
  expect(nav.select(items[1]!, "@a", 2)).toBeNull();
  expect(nav.key("/", items, items[0], "@ser", 4)).toEqual({ text: "@server/", caret: 8 });
  expect(nav.key("Backspace", items, items[0], "@server/", 8)).toEqual({ text: "@", caret: 1 });
});
it("malformed folder metadata cannot be used for slash navigation", () => {
  const nav = explorerNavigation({ cwd: "/project", query: "folder", head: "", commonPrefix: "", loading: false, next: undefined, previous: undefined });
  expect(nav.key("/", [{ id: "malformed", type: "directory", label: "folder", metadata: {} }], { id: "malformed", type: "directory", label: "folder", metadata: {} }, "@folder", 7)).toEqual({ text: "@folder", caret: 7 });
});
it("separates all item kinds and arbitrary sentinel-like identities from UI keys", () => {
  const names = ["next", "previous", "__page:next", "action:006e006500780074", "agent:006e006500780074", "line\nname", "\ud800"];
  const ids = names.flatMap(name => ["file", "directory", "agent", "action"].map(type => mentionItemId(type as "file" | "directory" | "agent" | "action", name)));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every(id => !/\s/u.test(id))).toBe(true);
  expect(ids).toContain(explorerPageItem("next").id);
});
it.each(["a]b.md", "a]b", "a\nb.md", ":file[a].md", "my folder.md", 'quote"name.md', "quote'name.md", "control\u0001.md"])("quotes awkward paths readably and parses the exact file back: %j", name => {
  const path = "/project/" + name;
  const item = explorerItems([{ name, path, kind: "file", project: false }], "/project")[0]!;
  const serialized = mentionFormatter.serialize(item);
  expect(serialized).toBe(quotedMentionPath(name));
  expect(serialized.startsWith('@"')).toBe(true);
  expect(JSON.parse(serialized.slice(1))).toBe(name);
  expect(mentionFormatter.parse(serialized)).toEqual([{ kind: "mention", type: "file", id: name, label: name }]);
});
it("keeps ordinary at-sign prose as text while parsing path-shaped tokens and legacy directives", () => {
  expect(mentionFormatter.parse("Ask @sam or email sam@example.com")).toEqual([{ kind: "text", text: "Ask @sam or email sam@example.com" }]);
  expect(mentionFormatter.parse("Read @server/index.ts and @server/")).toEqual([
    { kind: "text", text: "Read " },
    { kind: "mention", type: "file", id: "server/index.ts", label: "server/index.ts" },
    { kind: "text", text: " and " },
    { kind: "mention", type: "directory", id: "server/", label: "server/" },
  ]);
  expect(mentionFormatter.parse(":file[old.ts]{name=/project/old.ts}")).toEqual([{ kind: "mention", type: "file", id: "/project/old.ts", label: "old.ts" }]);
});
it("Tab completes the host-wide prefix, not the selected row", () => {
  const items = explorerItems([{ name: "node-one", path: "/project/node-one", project: false, kind: "directory" }], "/project");
  const nav = explorerNavigation({ cwd: "/project", query: "no", head: "", commonPrefix: "node-", loading: false, next: undefined, previous: undefined });
  expect(nav.key("Tab", items, items[0], "@no", 3)).toEqual({ text: "@node-", caret: 6 });
  expect(nav.key("Tab", items, items[0], "@server/", 8)).toEqual({ text: "@server/", caret: 8 });
});
