import { expect, it } from "vitest";
import {
  matchProjectMention,
  parentProjectQuery,
  projectMentionFormatter,
  quotedProjectMentionPath,
  replaceProjectQuery,
  resolveProjectPath,
} from "../../src/components/thread/project-path.js";
import { explorerItems, explorerNavigation, explorerPageItem, mentionItemId } from "../../src/components/thread/project-explorer-model.js";

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
it("keeps inner-space queries active and treats quoted insertions as finished", () => {
  const pathQuery = "Read @server/ind";
  expect(matchProjectMention(pathQuery, "@", pathQuery.length)).toMatchObject({ query: "server/ind" });
  const spacedQuery = "@my fo";
  expect(matchProjectMention(spacedQuery, "@", spacedQuery.length)).toMatchObject({ query: "my fo" });
  expect(replaceProjectQuery(spacedQuery, spacedQuery.length, "my folder/")).toEqual({ text: "@my folder/", caret: 11 });
  for (const text of ['@"./my folder/"', '@"./my folder/"i']) {
    expect(matchProjectMention(text, "@", text.length)).toBeNull();
  }
  expect(matchProjectMention("@server/ ", "@", 9)).toBeNull();
  expect(replaceProjectQuery("Read @ser then", 9, "server/")).toEqual({ text: "Read @server/ then", caret: 13 });
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
it("projects canonical host paths and anchors in-session insertions", () => {
  const items = explorerItems([
    { name: "server", path: "/project/server", project: false, kind: "directory" },
    { name: "a.txt", path: "/project/a.txt", project: false, kind: "file" },
    { name: "outside.txt", path: "C:\\Users\\me\\outside.txt", project: false, kind: "file" },
  ], "/project");
  expect(items.map((item) => [item.metadata?.identity, item.type])).toEqual([["/project/server/", "directory"], ["/project/a.txt", "file"], ["C:/Users/me/outside.txt", "file"]]);
  expect(items.map(item => projectMentionFormatter.serialize(item))).toEqual(["@./server/", "@./a.txt", "@C:/Users/me/outside.txt"]);
  expect(projectMentionFormatter.parse(projectMentionFormatter.serialize(items[0]!))).toEqual([{ kind: "mention", type: "directory", id: "server/", label: "server/" }]);
  const nav = explorerNavigation({ cwd: "/project", query: "ser", head: "", commonPrefix: "", loading: false, next: undefined, previous: undefined });
  expect(nav.select(items[0]!, "@ser", 4)).toBeNull();
  expect(nav.select(items[1]!, "@a", 2)).toBeNull();
  expect(nav.key("/", items, items[0], "@ser", 4)).toEqual({ text: "@server/", caret: 8 });
  expect(nav.key("Backspace", items, items[0], "@server/", 8)).toEqual({ text: "@", caret: 1 });
});
it("keeps slash, Tab and Backspace navigation working for inner-space queries", () => {
  const item = explorerItems([{ name: "my folder", path: "/project/my folder", project: false, kind: "directory" }], "/project")[0]!;
  const nav = explorerNavigation({ cwd: "/project", query: "my fo", head: "", commonPrefix: "my folder", loading: false, next: undefined, previous: undefined });
  expect(nav.key("Tab", [item], item, "@my fo", 6)).toEqual({ text: "@my folder", caret: 10 });
  expect(nav.key("/", [item], item, "@my fo", 6)).toEqual({ text: "@my folder/", caret: 11 });
  expect(nav.key("Backspace", [item], item, "@my folder/", 11)).toEqual({ text: "@", caret: 1 });
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
it.each([
  "Makefile", "LICENSE", "README", "Dockerfile", 'quote"name.md', "back\\slash.md", "tab\tname.md",
  "line\nname.md", "close]name.md", "emoji-🛠️.md", "trailing ", "C:/Users/me/file.txt",
  "C:\\Users\\me\\file.txt", "@leading.md", '"leading.md',
])("round-trips the exact picked identity: %j", identity => {
  const item = { id: `file:${identity}`, type: "file", label: identity } as const;
  const serialized = projectMentionFormatter.serialize(item);
  expect(projectMentionFormatter.parse(serialized)).toEqual([{ kind: "mention", type: "file", id: identity, label: identity }]);
});
it.each(["a]b.md", "a\nb.md", ":file[a].md", "my folder.md", 'quote"name.md', "trailing "])("quotes awkward paths with the anchor inside: %j", name => {
  const serialized = projectMentionFormatter.serialize({ id: name, type: "file", label: name });
  expect(serialized).toBe(quotedProjectMentionPath(name));
  expect(serialized.startsWith('@"./')).toBe(true);
  expect(JSON.parse(serialized.slice(1))).toBe(`./${name}`);
  expect(projectMentionFormatter.parse(serialized)).toEqual([{ kind: "mention", type: "file", id: name, label: name }]);
});
it.each([
  "@lasercode/protocol", "@assistant-ui/react", "@narumitw/pi-goal", "@octocat/hello-world", "@dan.abramov", "@v1.2.3",
])("keeps ordinary %s prose intact", token => {
  const text = `Use ${token} here`;
  expect(projectMentionFormatter.parse(text)).toEqual([{ kind: "text", text }]);
});
it("parses only anchored readable paths and keeps agent handles as text", () => {
  expect(projectMentionFormatter.parse("Read @./server/index.ts, @../shared.ts, @/outside.ts, @~/notes.md and @C:\\code\\x.ts")).toEqual([
    { kind: "text", text: "Read " },
    { kind: "mention", type: "file", id: "server/index.ts", label: "server/index.ts" },
    { kind: "text", text: ", " },
    { kind: "mention", type: "file", id: "../shared.ts", label: "../shared.ts" },
    { kind: "text", text: ", " },
    { kind: "mention", type: "file", id: "/outside.ts", label: "/outside.ts" },
    { kind: "text", text: ", " },
    { kind: "mention", type: "file", id: "~/notes.md", label: "~/notes.md" },
    { kind: "text", text: " and " },
    { kind: "mention", type: "file", id: "C:\\code\\x.ts", label: "C:\\code\\x.ts" },
  ]);
  expect(projectMentionFormatter.serialize({ id: "audit", type: "agent", label: "audit" })).toBe("@audit");
  expect(projectMentionFormatter.parse("Ask @audit")).toEqual([{ kind: "text", text: "Ask @audit" }]);
  const awkwardAgent = projectMentionFormatter.serialize({ id: "odd", type: "agent", label: ":file[a]" });
  expect(awkwardAgent).toBe('@"\\u003afile[a]"');
  expect(projectMentionFormatter.parse(awkwardAgent)).toEqual([{ kind: "text", text: awkwardAgent }]);
});
it("keeps legacy directives authoritative when labels and identities contain at-signs", () => {
  expect(projectMentionFormatter.parse(":file[a @b.ts]{name=/p/a @b.ts}")).toEqual([
    { kind: "mention", type: "file", id: "/p/a @b.ts", label: "a @b.ts" },
  ]);
  expect(projectMentionFormatter.parse(":directory[my @dir/]{name=/p/my @dir/}")).toEqual([
    { kind: "mention", type: "directory", id: "/p/my @dir/", label: "my @dir/" },
  ]);
});
it.each([".", ",", ";", ":", "!", "?", ")", "]"])("leaves trailing %s outside a bare mention", punctuation => {
  expect(projectMentionFormatter.parse(`Read @./server/index.ts${punctuation}`)).toEqual([
    { kind: "text", text: "Read " },
    { kind: "mention", type: "file", id: "server/index.ts", label: "server/index.ts" },
    { kind: "text", text: punctuation },
  ]);
});
it("Tab completes the host-wide prefix, not the selected row", () => {
  const items = explorerItems([{ name: "node-one", path: "/project/node-one", project: false, kind: "directory" }], "/project");
  const nav = explorerNavigation({ cwd: "/project", query: "no", head: "", commonPrefix: "node-", loading: false, next: undefined, previous: undefined });
  expect(nav.key("Tab", items, items[0], "@no", 3)).toEqual({ text: "@node-", caret: 6 });
  expect(nav.key("Tab", items, items[0], "@server/", 8)).toEqual({ text: "@server/", caret: 8 });
});
