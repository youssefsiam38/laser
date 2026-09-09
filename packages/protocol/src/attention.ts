/**
 * Attention — the one status vocabulary (DESIGN.md "Status language").
 *
 * Five words, ranked. A container wears the loudest thing inside it, which is
 * what lets a session row, a fleet group and the app badge all say the same
 * thing without any of them owning a second rule.
 *
 * This used to live in the panel contract. Panels are gone; attention is not,
 * because it was never about panels — it is how work says whether it needs a
 * person.
 */
import type { SessionAttention } from "./messages.js";

export type Attention = SessionAttention;

/** Lower = more urgent. waiting > error > finished-unread > working > idle. */
export const ATTENTION_RANK: Readonly<Record<Attention, number>> = {
  waiting_for_input: 0,
  error: 1,
  finished_unread: 2,
  working: 3,
  idle: 4,
};

/** A container's status is the highest-attention status it contains. */
export function highestAttention(list: Iterable<Attention>): Attention {
  let best: Attention = "idle";
  for (const a of list) if (ATTENTION_RANK[a] < ATTENTION_RANK[best]) best = a;
  return best;
}
