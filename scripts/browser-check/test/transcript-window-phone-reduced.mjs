import switches from './transcript-window.mjs';

/**
 * The phone case the matrix cannot separate: dark theme with motion off, so a
 * slow phone input can be attributed to the animation rather than to the theme
 * it happens to travel with in the matrix.
 */
export default async function phoneReducedMotion(check) {
  process.env.TRANSCRIPT_REDUCED_MOTION = '1';
  await check.viewport(390);
  await check.theme('dark');
  await check.touch(true);
  await switches(check);
}
