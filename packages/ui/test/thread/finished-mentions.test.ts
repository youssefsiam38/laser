import { expect, it } from "vitest";
import type { Unstable_TriggerItem } from "@assistant-ui/react";

import { createFinishedMentions } from "../../src/components/thread/finished-mentions.js";
import { projectMentionFormatter } from "../../src/components/thread/project-path.js";

const file = (label: string): Unstable_TriggerItem => ({ id: `file:${label}`, type: "file", label });
const directory = (label: string): Unstable_TriggerItem => ({ id: `directory:${label}`, type: "directory", label });
const agent = (label: string): Unstable_TriggerItem => ({ id: `agent:${label}`, type: "agent", label });

/** What the picker does to a draft: replace the query with the token and one space. */
function choose(mentions: ReturnType<typeof createFinishedMentions>, draft: string, caret: number, item: Unstable_TriggerItem) {
  const match = mentions.matcher(draft, "@", caret);
  if (!match) throw new Error(`no query at ${caret} of ${JSON.stringify(draft)}`);
  const token = projectMentionFormatter.serialize(item);
  const after = draft.slice(match.endOffset);
  const text = draft.slice(0, match.offset) + token + (after.startsWith(" ") ? after : ` ${after}`);
  mentions.noteInsertion(item);
  mentions.advance(text);
  return { text, caret: match.offset + token.length + 1 };
}

/** One character at a time, the way a person produces text. */
function typeOn(mentions: ReturnType<typeof createFinishedMentions>, start: { text: string; caret: number }, suffix: string) {
  let { text, caret } = start;
  const opened: string[] = [];
  for (const char of suffix) {
    text = text.slice(0, caret) + char + text.slice(caret);
    caret += 1;
    if (mentions.matcher(text, "@", caret)) opened.push(text);
  }
  return { text, caret, opened };
}

it("finishes a chosen file: the picker never reopens for it, whatever follows", () => {
  const mentions = createFinishedMentions();
  mentions.matcher("", "@", 0);
  const typed = typeOn(mentions, { text: "", caret: 0 }, "@ser");
  expect(typed.opened.at(-1)).toBe("@ser");
  const chosen = choose(mentions, typed.text, typed.caret, file("server/index.ts"));
  expect(chosen.text).toBe("@./server/index.ts ");
  expect(mentions.matcher(chosen.text, "@", chosen.caret)).toBeNull();
  const after = typeOn(mentions, chosen, "and then some words");
  expect(after.opened).toEqual([]);
  expect(after.text).toBe("@./server/index.ts and then some words");
  expect(mentions.advance(after.text).map((tag) => [tag.start, tag.token, tag.type])).toEqual([[0, "@./server/index.ts", "file"]]);
});

it("keeps a query in flight open, including a folder name with inner spaces", () => {
  const mentions = createFinishedMentions();
  const typed = typeOn(mentions, { text: "Read ", caret: 5 }, "@./my fo");
  // Every keystroke of the name is still a query — the anchored spelling
  // alone is not a choice, which is why a parsed-segment matcher cannot be
  // used here. Only the trailing space itself closes the list, as it always
  // has, and the next letter of the folder's name brings it back.
  expect(typed.opened).toEqual(["Read @", "Read @.", "Read @./", "Read @./m", "Read @./my", "Read @./my f", "Read @./my fo"]);
  expect(mentions.matcher(typed.text, "@", typed.caret)).toMatchObject({ query: "./my fo", offset: 5 });
  expect(mentions.advance(typed.text)).toEqual([]);
});

it("carries several mentions, and a fresh @ after a finished one opens the picker", () => {
  const mentions = createFinishedMentions();
  const first = choose(mentions, "@ser", 4, directory("server/"));
  const prose = typeOn(mentions, first, "and ");
  expect(prose.opened).toEqual([]);
  const second = choose(mentions, prose.text + "@ind", prose.caret + 4, file("server/index.ts"));
  expect(second.text).toBe("@./server/ and @./server/index.ts ");
  const third = typeOn(mentions, second, "@au");
  expect(third.opened.at(-1)).toBe("@./server/ and @./server/index.ts @au");
  const handle = choose(mentions, third.text, third.caret, agent("audit"));
  expect(handle.text).toBe("@./server/ and @./server/index.ts @audit ");
  expect(mentions.advance(handle.text).map((tag) => [tag.start, tag.token, tag.type])).toEqual([
    [0, "@./server/", "directory"],
    [15, "@./server/index.ts", "file"],
    [34, "@audit", "agent"],
  ]);
  expect(typeOn(mentions, handle, "please").opened).toEqual([]);
});

it("re-anchors a finished mention when earlier text changes, and keeps its tag", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "@ser", 4, file("server/index.ts"));
  const typed = typeOn(mentions, chosen, "please read it");
  // Back to the front of the message, then more words there.
  const edited = typeOn(mentions, { text: typed.text, caret: 0 }, "Hello: ");
  expect(edited.text).toBe("Hello: @./server/index.ts please read it");
  expect(mentions.advance(edited.text).map((tag) => tag.start)).toEqual([7]);
  // And the end of the message is still ordinary prose, not a query.
  expect(typeOn(mentions, { text: edited.text, caret: edited.text.length }, " now").opened).toEqual([]);
});

it("editing inside a finished mention returns it to ordinary text and matches again", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "@ser", 4, file("server/index.ts"));
  // Deleting the space the picker added, with nothing after it, is not an edit
  // of the mention: the token still ends the draft, so it is still a mention.
  const alone = chosen.text.slice(0, 18);
  expect(mentions.matcher(alone, "@", 18)).toBeNull();
  expect(mentions.advance(alone)).toHaveLength(1);
  const typed = typeOn(mentions, chosen, "later");
  // Deleting it in front of a word is: `@./server/index.tslater` is one word,
  // and the transcript renders that as prose, so the composer stops tagging it
  // and the text may match as a query again.
  const space = typed.text.slice(0, 18) + typed.text.slice(19);
  expect(mentions.advance(space)).toEqual([]);
  expect(mentions.matcher(space, "@", 18)).toMatchObject({ offset: 0, query: "./server/index.ts" });
  // Deleting a character of the path is an edit of the mention itself.
  const cut = space.slice(0, 17) + space.slice(18);
  expect(mentions.matcher(cut, "@", 17)).toMatchObject({ offset: 0, query: "./server/index.t" });
  expect(mentions.advance(cut)).toEqual([]);
  // Removing the whole mention leaves plain text and no tag.
  const gone = "later";
  expect(mentions.matcher(gone, "@", 0)).toBeNull();
  expect(mentions.advance(gone)).toEqual([]);
});

it("treats a draft that arrives whole as finished: a paste, and a restored draft", () => {
  const pasted = createFinishedMentions();
  pasted.matcher("Read ", "@", 5);
  const text = "Read @./server/index.ts and @\"./my folder/\" now";
  expect(pasted.matcher(text, "@", text.length)).toBeNull();
  expect(pasted.advance(text).map((tag) => [tag.token, tag.type])).toEqual([
    ["@./server/index.ts", "file"],
    ['@"./my folder/"', "directory"],
  ]);
  const restored = createFinishedMentions();
  expect(restored.matcher("@./server/index.ts and then", "@", 26)).toBeNull();
  // A draft nobody is typing never pops the picker open by itself, so a
  // complete-looking path in a restored draft is a tag. One Backspace makes
  // it a query again, which is how the person reopens it deliberately.
  const half = createFinishedMentions();
  expect(half.matcher("look at @./ser", "@", 14)).toBeNull();
  expect(half.matcher("look at @./se", "@", 13)).toMatchObject({ query: "./se", offset: 8 });
});

it("finishes a handle that arrived whole: a restored draft, and a paste", () => {
  // The reported defect, for the other kind of mention: a handle the person
  // chose before a reload is not a path, so the transcript's scanner never
  // sees it (D-284) and only the arrival itself says it was chosen.
  const restored = createFinishedMentions();
  const draft = "ask @audit about @./server/index.ts today";
  expect(restored.matcher(draft, "@", draft.length)).toBeNull();
  expect(restored.advance(draft).map((tag) => [tag.start, tag.token, tag.type])).toEqual([
    [4, "@audit", "agent"],
    [17, "@./server/index.ts", "file"],
  ]);
  expect(typeOn(restored, { text: draft, caret: draft.length }, " please").opened).toEqual([]);

  // The same text pasted into a draft that is already open.
  const pasted = createFinishedMentions();
  pasted.matcher("Hey ", "@", 4);
  const after = `Hey ${draft}`;
  expect(pasted.advance(after).map((tag) => tag.token)).toEqual(["@audit", "@./server/index.ts"]);
  expect(pasted.matcher(after, "@", after.length)).toBeNull();

  // Typing one is still a question: the list opens on every keystroke of it.
  const typing = createFinishedMentions();
  const typed = typeOn(typing, { text: "ask ", caret: 4 }, "@aud");
  expect(typed.opened).toEqual(["ask @", "ask @a", "ask @au", "ask @aud"]);
  expect(typing.matcher(typed.text, "@", typed.caret)).toMatchObject({ query: "aud", offset: 4 });
  expect(typing.advance(typed.text)).toEqual([]);
  // And a handle that ends where the paste ends is where the caret is, so it
  // stays a query too.
  const half = createFinishedMentions();
  half.matcher("ask ", "@", 4);
  expect(half.matcher("ask @aud", "@", 8)).toMatchObject({ query: "aud", offset: 4 });
});

it("drops a mention that loses its boundary, and takes it back when the boundary returns", () => {
  // A mention is not its characters. The transcript chips none of these, so
  // the composer tags none of them either.
  const before = createFinishedMentions();
  const chosen = choose(before, "hi @ser", 7, file("server/index.ts"));
  expect(chosen.text).toBe("hi @./server/index.ts ");
  const glued = "hi@./server/index.ts ";
  expect(before.advance(glued)).toEqual([]);
  // The record survives the broken state: typing a word in front of a mention
  // passes through it on the way to a boundary that is whole again.
  expect(before.advance("hi @./server/index.ts ").map((tag) => tag.start)).toEqual([3]);

  const between = createFinishedMentions();
  const first = choose(between, "@a", 2, file("a.ts"));
  const second = choose(between, `${first.text}@b`, first.caret + 2, file("b.ts"));
  expect(second.text).toBe("@./a.ts @./b.ts ");
  expect(between.advance("@./a.ts@./b.ts ")).toEqual([]);

  const ahead = createFinishedMentions();
  const only = choose(ahead, "@a", 2, file("a.ts"));
  expect(only.text).toBe("@./a.ts ");
  expect(ahead.advance("y@./a.ts ")).toEqual([]);
});

it("survives undo and redo, which replace the whole draft at once", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "@ser", 4, file("server/index.ts"));
  const typed = typeOn(mentions, chosen, "please read it");
  expect(mentions.advance(typed.text)).toHaveLength(1);
  // Undo writes the earlier text in one go; redo writes the later one.
  expect(mentions.advance(chosen.text).map((tag) => tag.start)).toEqual([0]);
  expect(mentions.advance(typed.text).map((tag) => tag.start)).toEqual([0]);
  expect(typeOn(mentions, { text: typed.text, caret: typed.text.length }, " now").opened).toEqual([]);
  // An undo that takes the mention itself away leaves ordinary text behind.
  expect(mentions.advance("@ser")).toEqual([]);
});

it("a paste over a selection replaces what it covers and finishes what it brings", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "Read @a", 7, file("a.ts"));
  const draft = typeOn(mentions, chosen, "now");
  expect(draft.text).toBe("Read @./a.ts now");
  // Select `now` and paste a mention and a word over it.
  const replaced = "Read @./a.ts @./b.ts here";
  expect(mentions.advance(replaced).map((tag) => [tag.start, tag.token])).toEqual([
    [5, "@./a.ts"],
    [13, "@./b.ts"],
  ]);
  // A selection that straddles the first mention takes it with it.
  const straddled = "Read @./a and @./b.ts here";
  expect(mentions.advance(straddled).map((tag) => tag.token)).toEqual(["@./b.ts"]);
});

it("two composers never see each other's mentions", () => {
  const session = createFinishedMentions();
  const bubble = createFinishedMentions();
  const chosen = choose(session, "@ser", 4, file("server/index.ts"));
  bubble.matcher("", "@", 0);
  // The same characters, typed into the other composer: nothing was chosen
  // there, so the question is still open there.
  const typed = typeOn(bubble, { text: "", caret: 0 }, chosen.text.trimEnd());
  expect(bubble.matcher(typed.text, "@", typed.caret)).toMatchObject({ offset: 0, query: "./server/index.ts" });
  expect(bubble.advance(typed.text)).toEqual([]);
  expect(session.advance(chosen.text)).toHaveLength(1);
});

it("an IME commit beside a mention is text, not a choice", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "@ser", 4, file("server/index.ts"));
  // A composition commits several characters at once, the way a paste does.
  const committed = `${chosen.text}\u3053\u3093\u306b\u3061\u306f`;
  expect(mentions.advance(committed).map((tag) => tag.start)).toEqual([0]);
  // And a word the composition starts with `@` is a query, not a finished
  // mention: it ends where the commit ends, which is where the caret is.
  const asking = `${committed} @\u3042\u3044`;
  expect(mentions.advance(asking).map((tag) => tag.start)).toEqual([0]);
  expect(mentions.matcher(asking, "@", asking.length)).toMatchObject({ query: "\u3042\u3044" });
});

it("recovers from a render that advanced it with text the composer never kept", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "@ser", 4, file("server/index.ts"));
  const typed = typeOn(mentions, chosen, "please");
  const tags = mentions.advance(typed.text).map((tag) => [tag.start, tag.token]);
  // A render React threw away, one keystroke behind, then the committed text
  // again: the record is a reduction over text, so it has to land in the same
  // place whatever order it sees.
  mentions.advance(typed.text.slice(0, -1));
  expect(mentions.advance(typed.text).map((tag) => [tag.start, tag.token])).toEqual(tags);
  // Even a text from much earlier cannot corrupt it.
  mentions.advance(chosen.text);
  expect(mentions.advance(typed.text).map((tag) => [tag.start, tag.token])).toEqual(tags);
});

it("a Tab completion and a slash descent are not choices", () => {
  const mentions = createFinishedMentions();
  const typed = typeOn(mentions, { text: "", caret: 0 }, "@nod");
  // Tab writes the common prefix; `/` descends. Both replace several
  // characters at once, and neither is the person choosing a row.
  const completed = "@node_modules/";
  expect(mentions.matcher(completed, "@", completed.length)).toMatchObject({ query: "node_modules/" });
  expect(mentions.advance(completed)).toEqual([]);
  expect(typed.opened.at(-1)).toBe("@nod");
});

it("a quoted choice is finished, and its payload is the quoted token", () => {
  const mentions = createFinishedMentions();
  const chosen = choose(mentions, "@my", 3, file("my folder.md"));
  expect(chosen.text).toBe('@"./my folder.md" ');
  expect(typeOn(mentions, chosen, "please").opened).toEqual([]);
  expect(mentions.advance(chosen.text).map((tag) => [tag.token, tag.label])).toEqual([['@"./my folder.md"', "my folder.md"]]);
});
