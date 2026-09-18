import assert from 'node:assert/strict';

let toggleSequence = 0;
async function tapDisclosure(button) {
  await button.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await button.tap();
}

async function toggleOnce(page, button, action, description) {
  const probeSelector = `activity-toggle-${++toggleSequence}`;
  await button.evaluate((element, probe) => element.setAttribute('data-activity-probe', probe), probeSelector);
  const before = await button.getAttribute('aria-expanded');
  assert.ok(before === 'true' || before === 'false', `${description}: disclosure exposes aria-expanded`);
  await button.evaluate(element => {
    const record = [];
    const observer = new MutationObserver(() => record.push(element.getAttribute('aria-expanded')));
    observer.observe(element, { attributes: true, attributeFilter: ['aria-expanded'] });
    window.__activityToggleProbe = { record, observer };
  });
  await action();
  await page.waitForFunction(
    ({ selector, before }) => document.querySelector(selector)?.getAttribute('aria-expanded') !== before,
    { selector: `[data-activity-probe="${probeSelector}"]`, before },
  );
  await page.waitForTimeout(80);
  const result = await button.evaluate(element => {
    const probe = window.__activityToggleProbe;
    probe?.observer.disconnect();
    delete window.__activityToggleProbe;
    return { expanded: element.getAttribute('aria-expanded'), mutations: probe?.record ?? [] };
  });
  assert.equal(result.expanded, before === 'true' ? 'false' : 'true', `${description}: action inverts the disclosure`);
  assert.deepEqual(result.mutations, [result.expanded], `${description}: action toggles exactly once`);
}

async function selectVisibleText(check, text, button, description) {
  const before = await button.getAttribute('aria-expanded');
  await check.page.evaluate(() => getSelection()?.removeAllRanges());
  const box = await text.boundingBox();
  assert.ok(box && box.width > 12 && box.height > 0, `${description}: visible text has selectable geometry`);
  const y = box.y + box.height / 2;
  await check.page.mouse.move(box.x + 2, y);
  await check.page.mouse.down();
  await check.page.mouse.move(box.x + Math.max(12, box.width * 0.7), y, { steps: 8 });
  await check.page.mouse.up();
  const selected = await text.evaluate(element => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) return { text: '', inside: false };
    const range = selection.getRangeAt(0);
    return {
      text: selection.toString(),
      inside: element.contains(range.startContainer) && element.contains(range.endContainer),
    };
  });
  assert.ok(selected.text.trim().length >= 3, `${description}: pointer drag creates a genuine partial selection`);
  assert.ok(selected.text.length < ((await text.textContent()) ?? '').length, `${description}: selection is partial, not a synthetic whole-label copy`);
  assert.equal(selected.inside, true, `${description}: selection range belongs to the visible label`);
  assert.equal(await button.getAttribute('aria-expanded'), before, `${description}: selecting text does not toggle disclosure`);

  const origin = new URL(check.page.url()).origin;
  await check.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await check.page.keyboard.press('Control+c');
  const copied = await check.page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, selected.text, `${description}: the native selection is copyable`);
  return selected.text;
}

async function mixedLabelBodyFindEvidence(check, caseLabel) {
  const query = `${caseLabel.replaceAll('-', ' ')} body`;
  await check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: `Run mixed labelled fixture ${caseLabel}` }],
  });
  const row = check.page.locator('[data-slot="tool-call"][data-tool="bash"]')
    .filter({ hasText: `Reading ${query}` }).last();
  const button = row.locator('button[data-slot="tool-fallback-trigger"]');
  if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  assert.equal(await button.getAttribute('aria-expanded'), 'false', 'mixed-match row starts folded');
  await row.evaluate(element => element.setAttribute('data-mixed-find-row', ''));

  await check.page.keyboard.press('Control+f');
  const input = check.page.getByRole('textbox', { name: 'Find in conversation' });
  await input.fill(query);
  await check.page.getByRole('status').filter({ hasText: '1 / 2' }).waitFor();
  assert.equal(await button.getAttribute('aria-expanded'), 'true', 'a matching hidden body mounts even when the label also matches');
  const ranges = await check.page.evaluate(() => {
    const row = document.querySelector('[data-mixed-find-row]');
    const content = row?.querySelector('[data-slot="tool-fallback-content"]');
    const all = [...(CSS.highlights?.get('conversation-matches') ?? [])];
    const current = [...(CSS.highlights?.get('conversation-current') ?? [])];
    return {
      all: all.map(range => range.toString()),
      currentInBody: current.length === 1 && Boolean(content?.contains(current[0].startContainer)),
    };
  });
  assert.deepEqual(ranges.all, [query, query], 'both indexed occurrences have paintable DOM ranges');
  assert.equal(ranges.currentInBody, false, 'the first occurrence is the visible label');

  await check.page.getByRole('button', { name: 'Next match' }).click();
  await check.page.getByRole('status').filter({ hasText: '2 / 2' }).waitFor();
  await check.page.waitForFunction(expected => {
    const label = document.querySelector('[data-mixed-find-row] [data-slot="tool-fallback-trigger-label"]');
    const current = [...(CSS.highlights?.get('conversation-current') ?? [])];
    return current.length === 1 && current[0].toString() === expected
      && !label?.contains(current[0].startContainer);
  }, query);
  assert.equal(await button.getAttribute('aria-expanded'), 'true', 'navigating to the body match keeps it revealed');
  await input.press('Escape');
  assert.equal(await button.getAttribute('aria-expanded'), 'false', 'closing find restores the folded preference');
}

async function requestInspectorDisclosureEvidence(check, promptText) {
  const userRow = check.page.locator('[data-role="user"]').filter({ hasText: promptText }).last();
  await userRow.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const more = userRow.getByRole('button', { name: 'More', exact: true });
  await more.waitFor();
  if (check.state.touch) await more.tap(); else await more.click();
  await check.page.getByRole('menuitem', { name: 'View API request', exact: true }).click();
  const dialog = check.page.getByRole('dialog', { name: 'API request', exact: true });
  await dialog.locator('[data-slot="request-viewport"]').waitFor({ timeout: 30000 });
  const button = dialog.locator('[data-slot="request-field-trigger"]').first();
  const chevron = button.locator('[data-slot="request-field-chevron"]');
  await button.waitFor();
  if (await button.getAttribute('aria-expanded') === 'true') {
    if (check.state.touch) await tapDisclosure(button); else await button.click();
  }
  const closedRotation = await chevron.evaluate(element => getComputedStyle(element).rotate);

  await dialog.getByRole('button', { name: 'Copy JSON', exact: true }).focus();
  await check.page.keyboard.press('Tab');
  assert.equal(await button.evaluate(element => element === document.activeElement), true, 'keyboard Tab reaches the request-field disclosure');
  const focus = await button.evaluate(element => ({
    visible: element.matches(':focus-visible'),
    style: getComputedStyle(element).outlineStyle,
    width: Number.parseFloat(getComputedStyle(element).outlineWidth),
  }));
  assert.equal(focus.visible, true, 'request-field disclosure receives keyboard focus visibly');
  assert.notEqual(focus.style, 'none', 'request-field disclosure paints a focus outline');
  assert.ok(focus.width >= 2, `request-field focus outline is at least 2px (${focus.width})`);

  if (!check.state.touch) {
    const box = await button.boundingBox();
    assert.ok(box, 'request-field disclosure has pointer geometry');
    await check.page.mouse.move(box.x - 8, box.y - 8);
    const idle = await button.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
    await button.hover();
    const hovered = await button.evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
      matches: element.matches(':hover'),
      supportsHover: matchMedia('(hover: hover)').matches,
    }));
    assert.equal(hovered.matches, true, 'pointer reaches the request-field hover state');
    // The shared browser context stays touch-capable so phone cases can call
    // touchscreen.tap(); Chromium therefore suppresses (hover: hover) even
    // after desktop touch emulation is disabled. Pin the built hover token in
    // that context, and compare computed paint whenever the media query exists.
    if (hovered.supportsHover) {
      assert.notEqual(hovered.background, idle.background, `request-field disclosure paints hover feedback (${JSON.stringify({ idle, hovered })})`);
    } else {
      assert.equal(await button.evaluate(element => element.classList.contains('hover:bg-surface-2')), true,
        'request-field disclosure carries the hover feedback token');
    }
    await toggleOnce(check.page, button, async () => {
      await check.page.mouse.down();
      assert.equal(await button.evaluate(element => element.matches(':active')), true,
        'request-field disclosure enters the pressed state');
      await check.page.mouse.up();
    }, 'request-field-pointer-toggle');
    const openRotation = await chevron.evaluate(element => getComputedStyle(element).rotate);
    assert.notEqual(openRotation, closedRotation, 'request-field chevron rotates after pointer press');
    await toggleOnce(check.page, button, () => button.press('Enter'), 'request-field-keyboard-toggle');
  } else {
    const target = await button.boundingBox();
    assert.ok(target && target.height >= 44, `request-field touch target is at least 44px (${JSON.stringify(target)})`);
    await toggleOnce(check.page, button, () => tapDisclosure(button), 'request-field-touch-toggle');
    const openRotation = await chevron.evaluate(element => getComputedStyle(element).rotate);
    assert.notEqual(openRotation, closedRotation, 'request-field chevron rotates after touch press');
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

async function humanisedFindEvidence(check, row, button, displayLabel, storedLabel) {
  assert.equal(await button.getAttribute('aria-expanded'), 'false', 'labelled row starts folded before find');
  await check.page.keyboard.press('Control+f');
  const input = check.page.getByRole('textbox', { name: 'Find in conversation' });
  await input.fill(displayLabel);
  await check.page.getByRole('status').filter({ hasText: '1 / 1' }).waitFor();
  const evidence = await check.page.evaluate(() => {
    const highlight = CSS.highlights?.get('conversation-current');
    const ranges = highlight ? [...highlight] : [];
    return ranges.map(range => ({
      text: range.toString(),
      slot: range.startContainer.parentElement?.closest('[data-slot]')?.getAttribute('data-slot'),
    }));
  });
  assert.deepEqual(evidence, [{ text: displayLabel, slot: 'tool-fallback-trigger-label' }],
    'find highlights the one visible humanised label');
  assert.equal(await button.getAttribute('aria-expanded'), 'false', 'finding an already-visible label keeps its body folded');
  assert.equal(await row.locator('[data-slot="tool-fallback-content"]').isHidden(), true, 'collapsed tool body stays hidden during label find');
  await input.press('Escape');

  await check.page.keyboard.press('Control+Shift+f');
  const saved = check.page.getByRole('combobox', { name: 'Search all sessions' });
  await saved.fill(displayLabel);
  const searchSurface = check.page.getByRole('dialog').filter({ has: check.page.getByRole('heading', { name: 'Search all sessions' }) });
  await searchSurface.getByText(displayLabel, { exact: false }).waitFor();
  assert.equal(await searchSurface.getByText(storedLabel, { exact: false }).count(), 0,
    'saved-history search never exposes the stored slug');
  await saved.press('Escape');
}

export default async function activityLabels(check) {
  const requestedWidth = check.state.width;
  if (check.state.touch && requestedWidth > 600) await check.viewport(390);
  if (!check.state.touch && requestedWidth === 390) await check.touch(true);
  await check.reducedMotion(false);
  assert.equal(await check.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), false,
    'normal-motion activity cases run with motion enabled');
  await check.page.addLocatorHandler(check.page.getByRole('button', { name: 'Got it', exact: true }), button => button.click());
  const caseLabel = `${requestedWidth}-${check.state.theme}`;
  const storedLabel = `checking-${caseLabel}-row`;
  const displayLabel = `Checking ${requestedWidth} ${check.state.theme} row`;

  await check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: 'Show fixture reasoning' }],
  });
  const reasoning = check.page.locator('[data-slot="activity-reasoning"]').last();
  const reasoningButton = reasoning.locator('button[data-slot="tool-group-trigger"]');
  await reasoningButton.waitFor();
  assert.equal(await reasoning.locator('[data-slot="tool-group-trigger-label"]').evaluate(element => Boolean(element.closest('button'))), false,
    'reasoning identity is selectable sibling text');
  await toggleOnce(check.page, reasoningButton, () => check.state.touch ? tapDisclosure(reasoningButton) : reasoningButton.press('Space'), 'reasoning-toggle');

  // Keep the RPC open until the command settles so this script proves both the
  // live and durable row from one real persisted tool call.
  const prompt = check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: `Run labelled fixture tool ${caseLabel}` }],
  });
  await check.page.waitForFunction(label => [...document.querySelectorAll('[data-slot="tool-call"][data-tool="bash"][data-state-row="running"]')]
    .some(element => element.textContent?.includes(label)), displayLabel);

  const row = check.page.locator('[data-slot="tool-call"][data-tool="bash"]')
    .filter({ hasText: displayLabel }).last();
  const label = row.locator('[data-slot="thinking-indicator-label"], [data-slot="tool-fallback-trigger-label"]').last();
  const button = row.locator('button[data-slot="tool-fallback-trigger"]');
  assert.ok((await button.getAttribute('aria-label'))?.startsWith(`${displayLabel}.`),
    'the native button remains findable by the humanised visible identity');
  assert.equal(await row.getAttribute('data-state-row'), 'running', 'the first interaction exercises a running specialised tool');
  assert.equal(await label.evaluate(element => Boolean(element.closest('button'))), false, 'visible label is a non-interactive sibling of the button');

  if (!check.state.touch) {
    await selectVisibleText(check, label, button, 'running specialised tool');
    await toggleOnce(check.page, button, () => button.click(), 'tool-toggle');
    await toggleOnce(check.page, button, () => button.press('Enter'), 'tool-toggle');
    await toggleOnce(check.page, button, () => button.press('Space'), 'tool-toggle');
    // Return to folded for the search and hidden-body assertions below.
    if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  } else {
    const target = await button.boundingBox();
    assert.ok(target && target.width >= 44 && target.height >= 44,
      `touch disclosure target is at least 44px (${JSON.stringify(target)})`);
    await toggleOnce(check.page, button, () => tapDisclosure(button), 'tool-toggle');
    await toggleOnce(check.page, button, () => tapDisclosure(button), 'tool-toggle');
  }

  await prompt;
  await check.page.waitForFunction(label => {
    const rows = [...document.querySelectorAll('[data-slot="tool-call"][data-tool="bash"]')];
    return rows.some(row => row.textContent?.includes(label) && row.getAttribute('data-state-row') === 'done');
  }, displayLabel);
  assert.equal(await row.getAttribute('data-state-row'), 'done', 'the same humanised row remains after settlement');
  assert.ok((await row.textContent())?.includes(displayLabel), 'settled row keeps the humanised label');
  assert.match(await row.textContent(), /Run[\s\S]*sleep 12/,
    'settled row keeps the human label primary and computed command secondary');

  await check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: 'Run labelled fixture error' }],
  });
  await check.waitFor('Reading missing config');
  const errorRow = check.page.locator('[data-slot="tool-call"][data-tool="read"]')
    .filter({ hasText: 'Reading missing config' }).last();
  assert.equal(await errorRow.getAttribute('data-state-row'), 'failed', 'legacy label is humanised on an error row');
  assert.equal(await errorRow.locator('[data-slot="tool-fallback-trigger-label"]').evaluate(element => Boolean(element.closest('button'))), false,
    'error-row label remains selectable sibling text');

  await check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: 'Run fixture activity sequence' }],
  });
  await check.waitFor('Activity sequence complete.');
  const aggregate = check.page.locator('[data-slot="tool-group-root"]')
    .filter({ has: check.page.locator('[data-slot="tool-group-trigger-row"]') })
    .filter({ hasText: /2|activities|commands|files/ }).last();
  const aggregateButton = aggregate.locator('button[data-slot="tool-group-trigger"]');
  if (await aggregateButton.count()) {
    assert.equal(await aggregate.locator('[data-slot="tool-group-trigger-label"]').evaluate(element => Boolean(element.closest('button'))), false,
      'aggregate identity is selectable sibling text');
    await toggleOnce(check.page, aggregateButton, () => check.state.touch ? tapDisclosure(aggregateButton) : aggregateButton.press('Enter'), 'aggregate-toggle');
  }

  await check.rpc('session/prompt', {
    path: check.fixture.path,
    content: [{ type: 'text', text: 'Run generic fixture tool' }],
  });
  const generic = check.page.locator('[data-slot="tool-call"][data-tool="inspect_fleet"]').last();
  if (await generic.count()) {
    assert.match(await generic.textContent(), /Using inspect_fleet/, 'generic fallback row keeps selectable visible identity');
    assert.equal(await generic.locator('[data-slot="tool-fallback-trigger-label"]').evaluate(element => Boolean(element.closest('button'))), false,
      'generic fallback text is outside its disclosure button');
  }

  if (await button.getAttribute('aria-expanded') === 'true') await button.click();
  await humanisedFindEvidence(check, row, button, displayLabel, storedLabel);
  await mixedLabelBodyFindEvidence(check, caseLabel);
  await requestInspectorDisclosureEvidence(check, `Run mixed labelled fixture ${caseLabel}`);

  await check.reducedMotion(true);
  assert.equal(await check.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true,
    'reduced-motion preference reaches the row');
  await toggleOnce(check.page, button, () => check.state.touch ? tapDisclosure(button) : button.press('Enter'), 'tool-toggle');
  await toggleOnce(check.page, button, () => check.state.touch ? tapDisclosure(button) : button.press('Enter'), 'tool-toggle');
  await check.shot('selectable-activity-labels');

  assert.equal(await check.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    'the page has no horizontal overflow');
}
