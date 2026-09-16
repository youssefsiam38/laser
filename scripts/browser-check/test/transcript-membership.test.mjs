import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import check from './transcript-membership.mjs';
import { fixture, target } from '../targets/transcript-membership.mjs';

test('real-host transcript membership target is registered and documented', async () => {
  assert.equal(typeof target, 'function');
  assert.equal(typeof fixture, 'function');
  assert.equal(typeof check, 'function');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /--target scripts\/browser-check\/targets\/transcript-membership\.mjs --fixture long --script scripts\/browser-check\/test\/transcript-membership\.mjs/);
});
