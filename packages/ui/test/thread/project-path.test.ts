import { expect, it } from "vitest";
import { matchProjectMention, parentProjectQuery, replaceProjectQuery, resolveProjectPath } from "../../src/components/thread/project-path.js";
import { explorerItems, explorerNavigation, explorerPageItem, mentionItemId, mentionFormatter, quotedMentionPath } from "../../src/components/thread/project-explorer-model.js";

it.each([
  ["@", "/project", "", ""], ["@/", "/", "", "/"], ["@./", "/project", "", "./"],
  ["@node", "/project", "node", ""], ["@./node", "/project", "node", "./"],
  ["@server/", "/project/server", "", "server/"], ["@server/ind", "/project/server", "ind", "server/"],
  ["@a/b/c", "/project/a/b", "c", "a/b/"], ["@server\\ind", "/project/server", "ind", "server/"],
  ["@a/../server/", "/project/server", "", "a/../server/"], ["@/project/server/ind", "/project/server", "ind", "/project/server/"],
  ["@..", "/", "", "../"], ["@../", "/", "", "../"], ["@a/../../", "/", "", "a/../../"],
  ["@../sibling/", "/sibling", "", "../sibling/"], ["@/elsewhere/file", "/elsewhere", "file", "/elsewhere/"],
  ["@C:\\elsewhere", "C:/", "elsewhere", "C:/"],
])("resolves %s", (query, directory, prefix, head) => {
  expect(resolveProjectPath(query, "/project")).toEqual({ ok: true, directory, prefix, head });
});
it.each(["@~", "@~/code", "@C:relative", "@server/ "])("refuses %s deliberately", (query) => {
  expect(resolveProjectPath(query, "/project")).toMatchObject({ ok: false, error: expect.any(String) });
});
it("resolves hand-typed Windows separators against a Windows project", () => {
  expect(resolveProjectPath("@C:\\code\\server\\ind", "C:\\code")).toEqual({ ok: true, directory: "C:/code/server", prefix: "ind", head: "C:/code/server/" });
  expect(resolveProjectPath("@..\\sibling\\ind", "C:\\code\\project")).toEqual({ ok: true, directory: "C:/code/sibling", prefix: "ind", head: "../sibling/" });
});
it("preserves surrounding text and closes at trailing whitespace", () => {
  expect(matchProjectMention("Read @server/ind then", "@", 16)).toMatchObject({ query: "server/ind" });
  expect(matchProjectMention("@server/ ", "@", 9)).toBeNull();
  expect(replaceProjectQuery("Read @ser then", 9, "server/")).toEqual({ text: "Read @server/ then", caret: 13 });
  expect(parentProjectQuery("a/b/")).toBe("a/");
  expect(parentProjectQuery("server/")).toBe("");
  expect(parentProjectQuery("./server/")).toBe("./");
  expect(parentProjectQuery("../", "/home/project")).toBe("../../");
  expect(parentProjectQuery("a/../server/", "/home/project")).toBe("");
  expect(parentProjectQuery("/", "/home/project")).toBeNull();
  expect(parentProjectQuery("/sibling/", "/home/project")).toBe("/");
});
it("projects a bounded host page without reordering, inserting directory directives, or losing chip identities", () => {
  const items = explorerItems([
    { name: "server", path: "/project/server", project: false, kind: "directory" },
    { name: "a.txt", path: "/project/a.txt", project: false, kind: "file" },
    { name: "outside.txt", path: "/project-other/outside.txt", project: false, kind: "file" },
  ], "/project");
  expect(items.map((item) => [item.metadata?.identity, item.type])).toEqual([["server", "directory"], ["a.txt", "file"], ["/project-other/outside.txt", "file"]]);
  const nav = explorerNavigation({ cwd: '/project', query: 'ser', head: "", commonPrefix: "", loading: false, next: undefined, previous: undefined });
  expect(nav.select(items[0]!, "@ser", 4)).toEqual({ text: "@server/", caret: 8 });
  expect(nav.select(items[1]!, "@a", 2)).toBeNull(); // the primitive owns file directive insertion
  expect(nav.key("Backspace", items, items[0], "@server/", 8)).toEqual({ text: "@", caret: 1 });
});
it.each(['/', 'C:/', '//server/share/'])('leaves root deletion to the input at %s', query => {
  expect(parentProjectQuery(query, '/project')).toBeNull();
  const nav = explorerNavigation({ cwd: '/project', query, head: query, commonPrefix: '', loading: false, next: undefined, previous: undefined });
  expect(nav.key('Backspace', [], undefined, '@' + query, query.length + 1)).toBeNull();
});
it.each([undefined, null, 1, {}, ''])('never writes undefined or coerced directory metadata: %j', name => {
  const nav = explorerNavigation({ cwd: '/project', query: '', head: '', commonPrefix: '', loading: false, next: undefined, previous: undefined });
  expect(nav.select({ id: 'malformed', type: 'directory', label: 'folder', metadata: { name } }, '@', 1)).toEqual({ text: '@', caret: 1 });
});
it('separates all item kinds and arbitrary sentinel-like identities from UI keys', () => {
  const names = ['next', 'previous', '__page:next', 'action:006e006500780074', 'agent:006e006500780074', 'line\nname', '\ud800'];
  const ids = names.flatMap(name => ['file', 'directory', 'agent', 'action'].map(type => mentionItemId(type as 'file' | 'directory' | 'agent' | 'action', name)));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every(id => !/\s/u.test(id))).toBe(true);
  expect(ids).toContain(explorerPageItem('next').id);
});
it.each(['a]b.md', 'a\nb.md', ':file[a].md', 'a'.repeat(1025)])('never shortens a plain-path fallback into a different file chip: %j', name => {
  const item = explorerItems([{ name, path: '/project/' + name, kind: 'file', project: false }], '/project')[0]!;
  const serialized = mentionFormatter.serialize(item);
  // Nested directive syntax is also data, even if the enclosing label can round-trip.
  const parsed = mentionFormatter.parse(serialized);
  if (name.includes(']') || name.includes('\n') || name.length > 1024) {
    expect(serialized).toBe(quotedMentionPath(name));
    expect(parsed).toEqual([{ kind: 'text', text: serialized }]);
    expect(JSON.parse(serialized)).toBe(name);
  } else expect(parsed).toEqual([{ kind: 'mention', type: 'file', id: name, label: name }]);
});

it("Tab completes the host-wide prefix, not the selected or locally loaded row", () => {
  const items = explorerItems([{ name: "node-one", path: "/project/node-one", project: false, kind: "directory" }], "/project");
  const nav = explorerNavigation({ cwd: '/project', query: 'no', head: "", commonPrefix: "node-", loading: false, next: undefined, previous: undefined });
  expect(nav.key("Tab", items, items[0], "@no", 3)).toEqual({ text: "@node-", caret: 6 });
  const stale = explorerNavigation({ cwd: '/project', query: "no", head: "", commonPrefix: "node-", loading: false, next: undefined, previous: undefined });
  expect(stale.key("Tab", items, items[0], "@server/", 8)).toEqual({ text: "@server/", caret: 8 });
});
