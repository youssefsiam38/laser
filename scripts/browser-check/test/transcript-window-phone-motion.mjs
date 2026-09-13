import switches from './transcript-window.mjs';

/**
 * The phone case with motion ON, dark theme: the one the matrix runs as part of
 * 390/dark, isolated so it can be measured on its own and compared with
 * `transcript-window-phone-reduced.mjs` (same width, same theme, motion off).
 * `TRANSCRIPT_PAIRS=20` takes the desktop's sample count.
 */
export default async function phoneMotion(check) {
  process.env.TRANSCRIPT_REDUCED_MOTION = '0';
  await check.viewport(390);
  await check.theme('dark');
  await check.touch(true);
  await switches(check);
}
