import type { Unstable_TriggerItem, Unstable_TriggerMatcher } from "@assistant-ui/react";

import { matchProjectMention, projectMentionFormatter, projectMentionSpans } from "./project-path.js";

/**
 * Which `@` in a draft is a **finished** mention, and which is still a query.
 *
 * `matchProjectMention` reads text alone, and text alone cannot tell the two
 * apart: `@./my fo` (a folder being typed, spaces and all) and
 * `@./server/index.ts and then` (a chosen file followed by prose) have the
 * same shape. Reading the parsed segments would call both finished and take
 * the picker away in the middle of `@./My Documents/re`, which the person is
 * still typing; the whitespace rule it replaced called both unfinished and
 * reopened the picker on every keystroke after a choice — the reported defect.
 *
 * So the honest signal is not in the string: a mention is finished because it
 * *arrived whole*. Two things produce one — the picker inserting a choice
 * (`noteInsertion`, which knows the exact range it wrote) and a draft arriving
 * in one piece (a paste, a restored draft, a prompt handed back by Edit or
 * Fork), where nothing was typed character by character. Everything else is a
 * query until the person chooses.
 *
 * A record is kept honest by the text itself. Every change is reduced to one
 * replaced span (common prefix/suffix), and each record is then:
 *
 *   - shifted, when the change is entirely before it — so editing the first
 *     sentence of a message never un-finishes a mention further down;
 *   - kept, when the change is entirely after it (including deleting the
 *     space the picker added);
 *   - dropped, when the change reaches into it or extends its end — the
 *     person is editing the mention, so it is ordinary text again and may
 *     match as a fresh query (D-299 keeps Backspace a plain deletion).
 *
 * Records are per composer: more than one can be on screen (Beam's bubble
 * over the session's own), and each owns its own draft.
 */
export type FinishedMention = {
  /** Index of the `@` that opens the token, in the current draft. */
  readonly start: number;
  /** The exact token as it sits in the draft: `@./server/index.ts`, `@"./my folder/"`, `@audit`. */
  readonly token: string;
  /** What the person chose: `file`, `directory` or `agent`. */
  readonly type: string;
  /** The readable identity, without the `@` or its `./` anchor. */
  readonly label: string;
};

export type FinishedMentions = {
  /**
   * Move the record on to `text` and return the mentions that are finished in
   * it. Idempotent for a text it has already seen, so the matcher and the
   * composer's own tag layer can both call it in any order.
   */
  advance(text: string): readonly FinishedMention[];
  /**
   * Take the choice the picker has just made. The draft it wrote may not have
   * reached this record yet, so the choice waits here for the text that
   * carries it — never for a second one.
   */
  noteInsertion(item: Unstable_TriggerItem): void;
  /** `matchProjectMention`, minus every `@` that already belongs to a finished mention. */
  readonly matcher: Unstable_TriggerMatcher;
};

type Change = { readonly start: number; readonly beforeEnd: number; readonly afterEnd: number };

/** One replaced span per change: everything outside the common prefix and suffix. */
function changedSpan(before: string, after: string): Change {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;
  let tail = 0;
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return { start, beforeEnd: before.length - tail, afterEnd: after.length - tail };
}

function mentionOf(span: { start: number; end: number; type: string; label: string }, text: string): FinishedMention {
  return { start: span.start, token: text.slice(span.start, span.end), type: span.type, label: span.label };
}

/** Where the picker's token landed: the offset it was written at, else the nearest well-formed copy. */
function locateToken(text: string, token: string, hint: number | undefined, scan: boolean): number | undefined {
  if (hint !== undefined && text.startsWith(token, hint)) return hint;
  if (!scan) return undefined;
  let best: number | undefined;
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    if (at > 0 && !/\s/u.test(text[at - 1]!)) continue;
    if (best === undefined || Math.abs(at - (hint ?? 0)) < Math.abs(best - (hint ?? 0))) best = at;
  }
  return best;
}

export function createFinishedMentions(): FinishedMentions {
  let text: string | undefined;
  let mentions: FinishedMention[] = [];
  let lastMatch: { offset: number } | undefined;
  let chosen: { token: string; type: string; label: string; at: number | undefined } | undefined;

  /**
   * Put the waiting choice into `into` if `next` carries it. Before the new
   * draft arrives only the exact offset the picker wrote at counts: the same
   * folder can be mentioned twice in one message, and the older copy must not
   * answer for the newer one. Once the draft is here, a moved token is
   * searched for, nearest to where it was written.
   */
  const take = (next: string, into: FinishedMention[], settled: boolean) => {
    if (!chosen) return;
    const start = locateToken(next, chosen.token, chosen.at, settled);
    if (start === undefined) {
      if (settled) chosen = undefined;
      return;
    }
    const mention = { start, token: chosen.token, type: chosen.type, label: chosen.label };
    const existing = into.findIndex((other) => other.start === start);
    if (existing >= 0) into.splice(existing, 1, mention);
    else into.push(mention);
    into.sort((a, b) => a.start - b.start);
    chosen = undefined;
  };

  const advance = (next: string): readonly FinishedMention[] => {
    if (next === text) return mentions;
    if (text === undefined) {
      // A composer that opens with words in it — a restored draft, a prompt
      // handed back by Edit or Fork — did not type them, so its mentions are
      // as finished as the choice that first wrote them.
      mentions = projectMentionSpans(next).map((span) => mentionOf(span, next));
      text = next;
      return mentions;
    }
    const change = changedSpan(text, next);
    const delta = next.length - text.length;
    const kept: FinishedMention[] = [];
    for (const mention of mentions) {
      const end = mention.start + mention.token.length;
      const moved =
        change.beforeEnd <= mention.start
          ? { ...mention, start: mention.start + delta }
          : change.start > end || (change.start === end && change.afterEnd === change.start)
            ? mention
            : undefined;
      if (moved && next.startsWith(moved.token, moved.start)) kept.push(moved);
    }
    // More than one character at once is not typing: it is a paste, a
    // dictated phrase, or a draft arriving in whole. A complete mention
    // inside what arrived is finished — but only one the arrival wrote past:
    // a mention that ends where the arrival ends is where the caret now sits,
    // so `@./node`, typed or pasted, still leaves the picker open on it. The
    // picker's own insertion ends there too, and is recorded by `take`, which
    // knows what was chosen rather than guessing from the characters.
    if (change.afterEnd - change.start > 1) {
      for (const span of projectMentionSpans(next)) {
        if (span.start < change.start || span.end >= change.afterEnd) continue;
        if (kept.some((mention) => mention.start === span.start)) continue;
        kept.push(mentionOf(span, next));
      }
    }
    kept.sort((a, b) => a.start - b.start);
    take(next, kept, true);
    mentions = kept;
    text = next;
    return mentions;
  };

  return {
    advance,
    noteInsertion: (item) => {
      chosen = { token: projectMentionFormatter.serialize(item), type: item.type, label: item.label, at: lastMatch?.offset };
      lastMatch = undefined;
      // The composer may already hold the new draft, or may be about to: try
      // now, and let the next text through `advance` finish the job.
      if (text !== undefined) {
        const next = [...mentions];
        take(text, next, false);
        mentions = next;
      }
    },
    matcher: (draft, char, caret) => {
      advance(draft);
      const match = matchProjectMention(draft, char, caret);
      const finished = match !== null && mentions.some((mention) => mention.start === match.offset);
      lastMatch = finished || match === null ? undefined : { offset: match.offset };
      return finished ? null : match;
    },
  };
}
