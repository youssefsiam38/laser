import { resourceTarget } from './resource-soak.mjs';
import { fixture as appFixture } from './fixtures.mjs';

/** Instrumented real host plus the ordinary browser fixture, for membership acceptance. */
export const target = resourceTarget('quick');

export async function fixture(targetState, runtime, name) {
  const seeded = await appFixture(targetState, runtime, name);
  return { ...seeded, ...targetState.resource };
}
