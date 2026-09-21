/**
 * The list sorts its row containers back into index order on its own debounce:
 * `useDOMOrder` in `@legendapp/list@3.3.5` schedules a 500 ms timeout and
 * reschedules it on every position update. A test that asserts anything about
 * focus, selection or DOM order has to drive that pass at its boundary rather
 * than race it — on a loaded machine it lands in the middle of a test, which is
 * how the M16-T62 focus assertion failed in an integrated gate and passed in
 * isolation.
 *
 * Drive it with `setTimeout`/`clearTimeout` faked and
 * `vi.advanceTimersByTime(LIST_DOM_ORDER_DEBOUNCE_MS)`; never with a sleep.
 */
export const LIST_DOM_ORDER_DEBOUNCE_MS = 500;
