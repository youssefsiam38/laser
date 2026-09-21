const MODIFIERS = Object.freeze({ control: 2, meta: 4 });

export function findShortcutEvents(platform = process.platform) {
  const modifiers = platform === 'darwin' ? MODIFIERS.meta : MODIFIERS.control;
  const base = { modifiers, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 };
  return [
    { type: 'keyDown', ...base },
    { type: 'char', ...base, text: 'f', unmodifiedText: 'f' },
    { type: 'keyUp', ...base },
  ];
}

export async function dispatchFindShortcut({ cdp, page, platform = process.platform, timeoutMs = 30_000 }) {
  await page.bringToFront();
  const before = await page.evaluate(() => {
    const mainThreads = [...document.querySelectorAll('[data-slot="thread"]')]
      .filter(thread => thread.getClientRects().length > 0);
    const mainThread = mainThreads.length === 1 ? mainThreads[0] : null;
    const nonOwningDialog = mainThread && [...document.querySelectorAll('[role="dialog"]')]
      .some(dialog => !dialog.contains(mainThread));
    return {
      visibility: document.visibilityState,
      documentFocused: document.hasFocus(),
      activeTag: document.activeElement?.tagName ?? null,
      visibleMainThreads: mainThreads.length,
      workbenchOpen: Boolean(document.querySelector('[aria-label="Workbench screens"]')),
      nonOwningDialog: Boolean(nonOwningDialog),
    };
  });
  if (before.visibility !== 'visible' || before.visibleMainThreads !== 1 || before.workbenchOpen || before.nonOwningDialog) {
    throw new Error(`Restored renderer was not ready for the main-thread shortcut: ${JSON.stringify(before)}`);
  }
  for (const event of findShortcutEvents(platform)) await cdp.send('Input.dispatchKeyEvent', event);
  const search = page.locator('[data-slot="conversation-search"]');
  let waitFailure = null;
  try { await search.waitFor({ state: 'visible', timeout: timeoutMs }); }
  catch (error) { waitFailure = error instanceof Error ? error.name : 'unknown'; }
  const after = await page.evaluate(() => ({
    visibility: document.visibilityState,
    searchVisible: Boolean(document.querySelector('[data-slot="conversation-search"]')?.getClientRects().length),
    activeInSearch: document.activeElement instanceof HTMLInputElement && Boolean(document.activeElement.closest('[data-slot="conversation-search"]')),
    activeTag: document.activeElement?.tagName ?? null,
  }));
  if (after.visibility !== 'visible' || !after.searchVisible || !after.activeInSearch) {
    throw new Error(`Restored keyboard shortcut had no visible DOM effect: ${JSON.stringify({ before, after, waitFailure })}`);
  }
  return { before, after, events: findShortcutEvents(platform).map(event => ({ type: event.type, modifiers: event.modifiers, key: event.key })) };
}
