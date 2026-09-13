import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import historyActions from './transcript-window-actions.mjs';

// The phone regression independently reuses the exact action assertions and
// shared target; no second app stack or personal session is involved.
export default async function phoneHistoryActions(check) {
  await check.page.evaluate(() => { Error.stackTraceLimit = 100; });
  await check.context.addInitScript(() => { Error.stackTraceLimit = 100; });
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  check.page.on('pageerror', error => {
    writeFileSync(join(check.root, 'phone-error-stack.txt'), error.stack ?? String(error));
    fail(error);
  });
  await check.viewport(390);
  await check.theme('dark');
  await check.touch(true);
  await Promise.race([historyActions(check), failed]);
}
