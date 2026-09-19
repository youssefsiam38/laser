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
  const typed = typeOn(mentions, chosen, "later");
  // Deleting the space the picker added is not an edit of the mention.
  const space = typed.text.slice(0, 18) + typed.text.slice(19);
  expect(mentions.matcher(space, "@", 18)).toBeNull();
  expect(mentions.advance(space)).toHaveLength(1);
  // Deleting a character of the path is.
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
