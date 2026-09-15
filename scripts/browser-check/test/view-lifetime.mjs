import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticPng } from '../resource/fixtures.mjs';
import { revealSessionRow, sidebarRowView } from '../resource/sidebar.mjs';
import { until } from '../lifecycle.mjs';

/**
 * RP-5 in front of a person: a window that has shown many conversations keeps
 * only a bounded few of their transcripts, and the person never notices except
 * that the app stays light.
 *
 * What this script proves, in a real browser, at both widths and in both
 * themes, is the experience half of that bound — the half a unit test cannot
 * see:
 *
 * - an inactive image conversation holds no decoded image in the document, and
 *   shows it again, decoded, when it is opened;
 * - a composer draft and an open approval survive a round trip through ten
 *   other conversations, and the approval is still answerable afterwards;
 *   the conversation holding them is never released while they are there;
 * - a question that arrives for a conversation whose transcript was released
 *   is visible and answerable, and opening it shows its transcript rather than
 *   an empty thread;
 * - re-entry never flashes the empty state or "Opening conversation" text over
 *   a conversation that has messages;
 * - the reader's place in the conversation on screen is not moved by visiting
 *   other conversations.
 *
 * The store-level bound itself (how many transcripts are retained, and their
 * bytes) is measured by the resource soak, which reads the app's own store;
 * this script deliberately asserts nothing it cannot see from the page.
 */
export default async function viewLifetime(check) {
  const { page } = check;
  const width = check.state.width;
  const touch = width === 390;
  const label = `${width}-${check.state.theme}`;
  await check.touch(touch);
  await check.reducedMotion(check.state.theme === 'light');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Not now', exact: true }), button => button.click());

  const project = check.fixture.project;
  const named = name => `${name} ${label}`;
  const newSession = async (name, prompts) => {
    const { state } = await check.rpc('session/new', { cwd: project });
    await check.rpc('pi/model/set', { path: state.path, model: { provider: 'stub', id: 'stub-1' } });
    for (const content of prompts) {
      const result = await check.rpc('session/prompt', { path: state.path, content });
      assert.ok(result.accepted, `the fixture prompt for ${name} was refused`);
      await until(async () => !(await check.rpc('session/load', { path: state.path })).state.isStreaming, `${name} to settle`, 60000);
    }
    await check.rpc('pi/session/rename', { path: state.path, name: named(name) });
    return state.path;
  };

  // The fixture tool every question in this run comes from, saved before any
  // session starts so each one loads it.
  await check.rpc('mcp/save', { cwd: project, scope: 'global', server: { name: 'fixture', transport: { kind: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../../../packages/worker/test/mcp/fixtures/stdio-server.mjs', import.meta.url))] }, tools: { alwaysLoad: true, approve: true }, startup: 'on-demand' } });
  await check.rpc('mcp/inspect', { cwd: project, scope: 'global', name: 'fixture' });

  // One conversation with a real image, one to hold a draft, one holding a
  // question, one that will be asked a question long after it is dormant, and
  // ten more to push them all out of any bounded cache.
  const image = syntheticPng(512, 3).toString('base64');
  const imaged = await newSession('View image', [[{ type: 'text', text: 'Here is the diagram.' }, { type: 'image', mimeType: 'image/png', data: image }]]);
  const drafted = await newSession('View draft', [[{ type: 'text', text: 'Review checkpoint 1: verify the implementation.' }]]);
  const later = await newSession('View later', [[{ type: 'text', text: 'Review checkpoint 2: verify the implementation.' }]]);
  const crowd = [];
  for (let index = 1; index <= 10; index++) crowd.push(await newSession(`View crowd ${index}`, [[{ type: 'text', text: `Review checkpoint ${index + 2}: verify the implementation.` }]]));

  // A conversation waiting on a tool approval, in the same project.
  const { state: askingState } = await check.rpc('session/new', { cwd: project });
  const asking = askingState.path;
  await check.rpc('pi/model/set', { path: asking, model: { provider: 'stub', id: 'stub-1' } });
  await check.rpc('pi/session/rename', { path: asking, name: named('View question') });
  const asked = check.rpc('session/prompt', { path: asking, content: [{ type: 'text', text: 'fixture-asking: please approve the fixture call' }] }).catch(() => {});

  await page.reload({ waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();

  // Every re-entry is watched: a conversation with messages must never show
  // the empty state, not even for one frame.
  await page.evaluate(() => {
    const state = { flashes: 0 };
    window.__viewLifetime = state;
    new MutationObserver(() => {
      if (document.querySelector('[data-slot="empty-state-greeting"]') && document.querySelector('[data-window-message]')) state.flashes += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });

  // The sidebar is the only way in, and it pages: reveal the row with the
  // product's own control rather than reaching past it.
  const rowsInProject = 15;
  const region = page.getByRole('region', { name: 'Sessions', exact: true });
  /** Show the sessions list the way a person does, and only when it is hidden. */
  const showSessions = async () => {
    if (await region.isVisible().catch(() => false)) return;
    await page.getByRole('button', { name: /^Sessions$|Show sessions/ }).first().click();
    await region.waitFor({ timeout: 30000 });
  };
  const open = async name => {
    if (touch) await showSessions();
    const view = sidebarRowView(check, { cwd: project, alias: named(name) });
    await view.group.first().waitFor({ state: 'visible', timeout: 60000 });
    await revealSessionRow(view, { alias: named(name), expectedRows: rowsInProject });
    await view.trigger.first().click();
    await page.getByRole('main').getByRole('heading', { name: named(name), exact: true }).waitFor();
  };
  const messageRows = () => page.locator('[data-window-message]');
  const decodedImages = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="message-image"]')]
    .map(node => ({ decoded: node.complete && node.naturalWidth > 0, width: node.naturalWidth })));
  const visitCrowd = async () => { for (let index = 1; index <= 10; index++) await open(`View crowd ${index}`); };

  // --- an inactive image conversation holds no decoded image -----------------
  await open('View image');
  await page.locator('[data-slot="message-image"]').first().waitFor();
  await until(async () => (await decodedImages())[0]?.decoded === true, 'the fixture image to decode', 20000);
  const shown = await decodedImages();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].width, 512, 'the image really decoded at its own size');

  await visitCrowd();
  assert.deepEqual(await decodedImages(), [], 'no decoded image is held for a conversation nobody is looking at');

  await open('View image');
  await until(async () => (await decodedImages())[0]?.decoded === true, 'the image to come back decoded', 20000);
  assert.ok((await messageRows().count()) > 0, 'the conversation is shown again, not left empty');

  // --- a draft and an approval survive ten other conversations ---------------
  await open('View draft');
  await composer.click();
  await composer.fill('an unsent thought');
  await open('View question');
  // The same question can offer its answer in more than one place (the tool
  // row and the footer above the composer); either is the person's way in.
  const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
  await allow.waitFor();

  await visitCrowd();

  await open('View draft');
  assert.equal(await composer.inputValue(), 'an unsent thought', 'the draft is still here after ten conversations');
  await open('View question');
  await allow.waitFor();
  assert.ok(await allow.isEnabled(), 'the approval is still answerable');

  // --- a question for a conversation whose transcript went -------------------
  await open('View later');
  await visitCrowd();
  const lateAsk = check.rpc('session/prompt', { path: later, content: [{ type: 'text', text: 'fixture-asking: please approve the fixture call' }] }).catch(() => {});
  if (touch) await showSessions();
  const laterView = sidebarRowView(check, { cwd: project, alias: named('View later') });
  await revealSessionRow(laterView, { alias: named('View later'), expectedRows: rowsInProject });
  // The row says what the session needs in its own hover description, and the
  // light record is the only thing it can be reading it from.
  const rowDescription = async () => (await laterView.trigger.first().getAttribute('title')) ?? '';
  await until(async () => (await rowDescription()).includes('Waiting for you'), 'the dormant conversation to ask for a person', 60000);
  await open('View later');
  const lateAllow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
  await lateAllow.waitFor();
  assert.ok((await messageRows().count()) > 0, 'its transcript is read again before the question is answered here');
  await lateAllow.click();
  await lateAllow.waitFor({ state: 'detached' });
  await lateAsk;

  // --- the reader's place on screen is not moved by other conversations ------
  await open('View image');
  const viewport = page.locator('[data-slot=thread-viewport]');
  await viewport.evaluate(element => { element.scrollTop = 0; });
  const place = await viewport.evaluate(element => element.scrollTop);
  await page.waitForTimeout(500);
  assert.equal(await viewport.evaluate(element => element.scrollTop), place, 'nothing moved the reader while they read');

  // --- and the approval waiting elsewhere is still answerable ----------------
  await open('View question');
  await allow.waitFor();
  await allow.click();
  await allow.waitFor({ state: 'detached' });
  await until(async () => !(await check.rpc('session/load', { path: asking })).state.isStreaming, 'the approved tool call to finish', 60000);
  await asked;

  const flashes = await page.evaluate(() => window.__viewLifetime.flashes);
  assert.equal(flashes, 0, 'no conversation with messages ever showed the empty state');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page scroll');

  const metrics = await page.evaluate(() => ({ domNodes: document.querySelectorAll('*').length, images: document.querySelectorAll('[data-slot="message-image"]').length }));
  writeFileSync(join(check.root, `view-lifetime-${label}.json`), JSON.stringify({
    label, sessions: { imaged, drafted, later, asking, crowd: crowd.length },
    draft: 'survived ten conversations', approval: 'answerable after ten conversations',
    lateQuestion: 'visible and answered on a released transcript', emptyStateFlashes: flashes, metrics,
  }, null, 2));
  await check.snapshot();
  await check.shot('view-lifetime');
}
