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

/**
 * The column's other budget: the width a row spends before its first
 * character.
 *
 * A row's leading gutter is the kind mark plus the air after it, and it is the
 * same for an agent and for a command so sibling titles line up down the
 * column. It used to be 20px + 8px = 28px, which with the row's own 12px of
 * padding put the first character of `pnpm vite dev --host --port 5173` 40px
 * in — an eighth of a 320px column, in front of a string the row is already
 * middle-truncating.
 *
 * 18px + 6px = 24px is the floor for a mark that carries two initials: the
 * mono face is 0.6em per character, which is 15.6px at the largest text-size
 * setting, and `size-4.5` is 15.75px once compact density takes the spacing
 * unit to 3.5px. Anything narrower clips a letter at some setting a person can
 * actually choose, and a clipped letter is the thing the legibility floor
 * forbids.
 *
 * `test/fleet/fit.test.tsx` reads the title's x back off the rendered DOM for
 * both kinds rather than trusting this comment.
 */
export const FLEET_MARK_SIZE = "size-4.5";
/** The air between the mark and the title. */
export const FLEET_MARK_GAP = "gap-1.5";
/** Lines that hang below line 1 start at the title's column. */
export const FLEET_TEXT_INDENT = "ps-6";
/** Mark plus gap, in px at the default (comfortable) spacing unit. */
export const FLEET_MARK_GUTTER_PX = 24;
