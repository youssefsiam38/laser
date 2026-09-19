/**
 * The fleet column's chrome budget.
 *
 * Chrome is everything between the top of the column and the first thing that
 * says something about the work: the panel header, and the one filter row.
 * The session group header is *not* chrome — it names the session, its
 * project and its counts, which is the first real content the column has.
 *
 * The budget exists because a 320px column has 288px of usable width and
 * whatever height the window gives it, and controls nobody touches most of the
 * time must not take a third of it. Two rows of filter chips plus a repeated
 * "In progress" band cost 92px before the first row of work; the counts they
 * duplicated were already in the panel header.
 *
 * Every band that counts against this budget carries `data-fleet-chrome` and a
 * fixed `h-*` height, so `test/fleet/chrome.test.tsx` can read the paint back
 * off the rendered DOM rather than trusting this comment.
 *
 * On a coarse pointer the filter row grows to a 44px touch target
 * (`pointer-coarse:h-11`, the legibility floor's hit-area rule). That is a
 * different pointer, not a different budget: the 72px is the fine-pointer
 * paint at 320px, which is where the column lives.
 */
export const FLEET_CHROME_BUDGET_PX = 72;

/** The panel header: the 48px band the sessions and telemetry columns share. */
export const FLEET_HEADER_HEIGHT = "h-12";

/** The one filter row: 24px of paint, 44px of target on a finger. */
export const FLEET_FILTERS_HEIGHT = "h-6 pointer-coarse:h-11";
