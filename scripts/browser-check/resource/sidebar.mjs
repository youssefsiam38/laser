/** Reading and driving the app's own sessions sidebar, and nothing else. */

const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * The sidebar as this run reads it: the one visible tabpanel of the selected
 * kind, the group section that owns this session's directory, that group's own
 * rows and that group's own real "Load more" control. Nothing here reaches into
 * another tab's panel, another group's control or a test-only hook.
 */
export function sidebarRowView(check, session) {
  const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
  const group = region.getByRole('tabpanel').locator(`section[data-cwd=${JSON.stringify(session.cwd)}]`);
  const escaped = session.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trigger = group.locator('[data-slot="aui_thread-list-item-trigger"]')
    .filter({ has: check.page.locator('[data-slot="aui_thread-list-item-title"]', { hasText: new RegExp(`^${escaped}$`) }) });
  const rows = group.locator('[data-slot="aui_thread-list-item-trigger"]');
  const control = group.getByRole('button', { name: /^(Load more|Show fewer|Loading chats…)$/ });
  return {
    region, group, trigger,
    isRowVisible: () => trigger.first().isVisible().catch(() => false),
    rowCount: () => rows.count().catch(() => 0),
    async loadMore() {
      const first = control.first();
      if (!await first.isVisible().catch(() => false)) return null;
      const label = ((await first.textContent().catch(() => '')) ?? '').trim();
      return { label, click: () => first.click() };
    },
  };
}

/**
 * Reveal one titled row by using the product's own paging, never by widening a
 * fixture or reading the store. Each real click reveals one more page, so the
 * number of clicks is bounded by the retained rows the run created (plus one
 * for a catalog page it still has to fetch), and a click that moves neither the
 * row into view nor the row count is a failure, not a retry.
 */
export async function revealSessionRow(view, { alias, expectedRows, pageSize = 7, settleMs = 10_000, pollMs = 100, sleepFor = sleep, now = () => Date.now() } = {}) {
  if (await view.isRowVisible()) return { alias, clicks: 0, revealedBy: 'already shown' };
  if (!Number.isInteger(expectedRows) || expectedRows < 1) {
    throw new Error(`Paging the sidebar for ${alias} needs the known retained row count of its group.`);
  }
  // The group already shows one page, so the rows it created need one click
  // less than its page count, plus one for a catalog page it still has to fetch.
  const maxClicks = Math.max(1, Math.ceil(expectedRows / pageSize) - 1) + 1;
  for (let clicks = 1; clicks <= maxClicks; clicks++) {
    const before = await view.rowCount();
    const control = await view.loadMore();
    if (!control) throw new Error(`The sidebar row for ${alias} is absent and its own group offers no "Load more" control at ${before} rows.`);
    if (control.label === 'Show fewer') throw new Error(`The sidebar group for ${alias} is fully expanded at ${before} rows and does not hold it.`);
    await control.click();
    const deadline = now() + settleMs;
    let revealed = false, progressed = false;
    while (now() <= deadline) {
      if (await view.isRowVisible()) { revealed = true; break; }
      if (await view.rowCount() > before) { progressed = true; break; }
      await sleepFor(pollMs);
    }
    if (revealed) return { alias, clicks, revealedBy: 'Load more' };
    if (!progressed) throw new Error(`"Load more" made no progress for ${alias}: ${before} rows before and after one real click within ${settleMs} ms.`);
  }
  throw new Error(`The sidebar row for ${alias} did not appear after ${maxClicks} real "Load more" clicks, the bound for ${expectedRows} retained rows in pages of ${pageSize}.`);
}

/**
 * Wait out the app's own reconnection. A bounded heap capture or a forced GC
 * stalls the host past the UI's heartbeat, and the app then rebuilds its
 * sidebar from the catalog when the socket is back. That is the product
 * behaving correctly under this run's own instrumentation, so the harness waits
 * for it rather than reading a sidebar that is still being rebuilt.
 */
export async function waitForConnected(check, timeoutMs) {
  await check.page.getByText(/(?:Re)?[Cc]onnecting to the host…|Disconnected from the host/).first()
    .waitFor({ state: 'hidden', timeout: timeoutMs });
}

export async function selectSession(check, session, { attempts = 3, connectTimeoutMs = 120_000, openTimeoutMs = 60_000 } = {}) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const region = check.page.getByRole('region', { name: 'Sessions', exact: true });
      if (!await region.isVisible().catch(() => false)) await check.page.getByRole('button', { name: /^Sessions$|Show sessions/ }).click();
      await waitForConnected(check, connectTimeoutMs);
      const kindTab = region.getByRole('tab', { name: session.kind === 'chat' ? 'Chat' : 'Code', exact: true });
      if (await kindTab.getAttribute('aria-selected') !== 'true') await kindTab.click();
      const view = sidebarRowView(check, session);
      await view.group.first().waitFor({ state: 'visible', timeout: connectTimeoutMs });
      await revealSessionRow(view, { alias: session.alias, expectedRows: session.groupRows });
      await view.trigger.first().click();
      await check.page.waitForFunction(title => document.querySelector('h1')?.textContent === title, session.alias, { timeout: openTimeoutMs });
      return;
    } catch (error) { failure = error; }
  }
  throw failure;
}

/** Open every session in the app's own store, checkpointing as the mode asks. */
export async function hydrate(check, sessions, every, onCheckpoint = async () => {}) {
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    await check.page.evaluate(async ({ path, alias }) => {
      const stable = window.__resourceSoak?.stable; if (!stable) throw new Error('UI stable provider action is unreachable.');
      window.__resourceSoak.aliases[path] = alias;
      await stable.openSession(path);
    }, { path: session.path, alias: session.alias });
    if ((index + 1) % every === 0 || index + 1 === sessions.length) await onCheckpoint(index + 1);
  }
  return check.page.evaluate(() => Object.keys(window.__resourceSoak.store.getSnapshot().open).length);
}
