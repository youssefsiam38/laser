import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { row, prompt } from './transcript-window.mjs';

/** Real engine notifications from an empty, already mounted session, not a preload. */
export default async function liveGrowth(check) {
  const { state } = await check.rpc('session/new', { cwd: check.fixture.project });
  const path = state.path;
  await check.rpc('pi/model/set', { path, model: { provider: 'stub', id: 'stub-1' } });
  await check.rpc('pi/session/rename', { path, name: 'C live from start' });
  await (await row(check, 'C live from start')).click();
  const samples = [];
  let turn = 0;
  try {
    for (turn = 1; turn <= 1000; turn++) {
      await prompt(check, path, turn);
      await check.page.waitForFunction(turn => {
        const viewport = document.querySelector('[data-slot="thread-viewport"]');
        const input = viewport?.querySelector('textarea[aria-label="Message"]');
        const last = [...(viewport?.querySelectorAll('[data-message-id]') ?? [])].at(-1);
        return input && !input.disabled && last?.textContent.includes(`Checkpoint ${turn} is complete.`);
      }, turn);
      if (turn % 100 === 0) samples.push(await check.page.evaluate(turn => ({ turn, mounted: document.querySelectorAll('[data-window-message]').length, nodes: document.getElementsByTagName('*').length, enabled: !document.querySelector('textarea[aria-label="Message"]').disabled }), turn));
    }
  } catch (error) {
    await writeFile(join(check.root, 'live-gate-failure.json'), JSON.stringify({ turn, samples, gate: await check.page.evaluate(() => ({ inputDisabled: document.querySelector('textarea[aria-label="Message"]')?.disabled, visibleText: document.body.innerText, mounted: document.querySelectorAll('[data-window-message]').length })) }, null, 2));
    throw error; // One exact failure capture; never extend heartbeat or retry the stream.
  }
  const { entries } = await check.rpc('pi/session/entries', { path });
  assert.equal(entries.filter(e => e.type === 'message').length, 2000);
  assert(samples.every(sample => sample.enabled && sample.mounted < 80));
  const copy = check.page.locator('[data-window-message]').last().getByRole('button', { name: 'Copy', exact: true });
  await copy.focus(); await copy.press('ControlOrMeta+a');
  await check.page.waitForFunction(() => document.querySelectorAll('[data-window-message]').length === 2000);
  const selection = await check.page.evaluate(() => ({ text: document.getSelection().toString(), ids: [...document.querySelectorAll('[data-message-id]')].map(n => n.dataset.messageId) }));
  assert.equal(new Set(selection.ids).size, 2000, 'canonical identity has no lost/duplicate messages');
  assert.equal([...selection.text.matchAll(/Checkpoint \d+ is complete\./g)].length, 1000, 'native selection includes every loaded response');
  await check.page.evaluate(() => document.getSelection().removeAllRanges());
  await check.page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await check.page.waitForFunction(() => document.querySelectorAll('[data-window-message]').length < 80);
  await writeFile(join(check.root, 'live-growth.json'), JSON.stringify({ turns: 1000, canonical: 2000, samples, nativeSelectionMessages: selection.ids.length }, null, 2));
  await check.shot('live-2000');
}
