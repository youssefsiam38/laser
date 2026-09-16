/**
 * The last prompt a person sent, read in bounded pages (RP-8).
 *
 * "Fork from last prompt" needs exactly one thing — the entry id of the most
 * recent user message on the live branch — and three surfaces ask for it: the
 * composer's slash command, the command palette and the top bar. All three used
 * to ask for the *whole* session tree to find it, which is the single largest
 * read this window can make and the one the host refuses first when memory is
 * short.
 *
 * So they ask for the conversation's tail instead: the last few entries, with a
 * body limit so a huge message arrives as metadata rather than bytes, and one
 * wider page when the first did not reach a prompt. Nothing is kept — the
 * answer is read, the id is taken, and the entries are dropped — so the cost is
 * a moment's allocation rather than a transcript in memory.
 *
 * The three outcomes are kept apart on purpose. A conversation that genuinely
 * has no prompt says so; one whose prompt is further back than we looked says
 * something different; and neither is ever reported as the other.
 */
import type { ClientRequests } from "@lasercode/protocol";

import { BODY_EXCERPT_MAX_BYTES } from "@/runtime/body-excerpt";

import { userEntryIds } from "./entries.js";

/** The first look: enough for the ordinary case of "the prompt I just sent". */
export const LAST_PROMPT_TAIL = 8;
/** The one wider look, when the tail held no prompt and history continues. */
export const LAST_PROMPT_TAIL_EXPANDED = 80;

export type EntriesRequest = (
  params: ClientRequests["pi/session/entries"]["params"],
) => Promise<ClientRequests["pi/session/entries"]["result"]>;

export type LastPromptOutcome =
  | { entryId: string; reason?: undefined }
  /** The branch is complete in what we read, and it holds no prompt. */
  | { entryId?: undefined; reason: "no-prompt" }
  /** There is more history than we looked at, and none of it was a prompt. */
  | { entryId?: undefined; reason: "not-found" };

/** The most recent user entry on the live branch of one page, if it has one. */
function promptOf(result: ClientRequests["pi/session/entries"]["result"]): string | undefined {
  return userEntryIds(result.entries, result.leafId).at(-1);
}

export async function lastPromptEntry(request: EntriesRequest, path: string): Promise<LastPromptOutcome> {
  const first = await request({ path, window: { tail: LAST_PROMPT_TAIL }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
  const found = promptOf(first);
  if (found) return { entryId: found };
  if (first.window?.complete === true) return { reason: "no-prompt" };
  const wider = await request({ path, window: { tail: LAST_PROMPT_TAIL_EXPANDED }, bodyLimit: BODY_EXCERPT_MAX_BYTES });
  const later = promptOf(wider);
  if (later) return { entryId: later };
  return wider.window?.complete === true ? { reason: "no-prompt" } : { reason: "not-found" };
}

/** What a person is told when there was no prompt to fork from. */
export const LAST_PROMPT_MESSAGES = {
  "no-prompt": "Nothing to fork yet: this session has no prompt.",
  "not-found": "Could not find the last prompt in this conversation’s recent history.",
} as const;

/** The sentence for an outcome that found nothing, or none when it found one. */
export function lastPromptMessage(outcome: LastPromptOutcome): string | undefined {
  return outcome.reason === undefined ? undefined : LAST_PROMPT_MESSAGES[outcome.reason];
}
