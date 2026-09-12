import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment, lifecycle, liveOwnedProcesses, until, freePort } from '../lifecycle.mjs';
import { shotName, matrixCases } from '../browser.mjs';
import { outsideCheckout } from '../index.mjs';
import { fixturePlan, answer } from '../targets/fixtures.mjs';

function temporary(t) { const root = mkdtempSync(join(tmpdir(), 'browser-check-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test('environment is allowlisted, isolated, and can spawn sh', async t => {
  const root = temporary(t);
  const env = isolatedEnvironment(root);
  for (const key of ['PI_SESSION', 'OPENAI_API_KEY', 'CUSTOM_AUTH_TOKEN', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'HTTP_PROXY', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[key], undefined);
  assert.ok(env.PATH.endsWith(':/usr/bin:/bin'));
  assert.equal(env.HOME, join(root, 'home'));
  assert.equal(env.TMPDIR, join(root, 'tmp'));
  assert.equal(env.XDG_DATA_HOME, join(root, 'data'));
  const life = lifecycle(root, env); t.after(() => life.close());
  const child = life.spawn('sh', ['-c', 'test -n "$HOME" && sh -c "exit 0"'], { env: { PATH: '/missing', PORT: '1234' } });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`sh exit ${code}`))); });
});
test('matrix cases and safe screenshot names are deterministic', () => {
  assert.equal(matrixCases().length, 4);
  assert.deepEqual(matrixCases().map(state => shotName('thread', state, true)), ['thread-1360-dark.png', 'thread-1360-light.png', 'thread-390-dark.png', 'thread-390-light.png']);
  assert.equal(shotName('thread', matrixCases(true)[0], true), 'thread-1360-dark-touch.png');
  assert.throws(() => shotName('../escape', {}, false), /Screenshot names/);
});
test('fixture plans have exact message and project counts', () => {
  for (const [name, count] of [['empty', 0], ['short', 4], ['long', 240], ['huge', 2000]]) assert.equal(fixturePlan(name).flatMap(p => p.sessions).flatMap(s => s.prompts).length * 2, count);
  const projects = fixturePlan('projects'); assert.equal(projects.length, 10); assert.ok(projects.every(p => p.sessions.length === 15));
  assert.deepEqual(fixturePlan('long'), fixturePlan('long'));
  assert.throws(() => fixturePlan('typo'), /Unknown fixture/);
  assert.ok(answer({ messages: [{ role: 'user', content: 'Show fixture reasoning' }] }).reasoning);
  assert.equal(answer({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Run fixture tools' }] }] }).toolCall.name, 'bash');
  assert.equal(answer({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Start fixture-asking' }] }] }).toolCall.name, 'start_agent');
});
test('teardown bookkeeping tracks owned groups, ignores unrelated processes and zombies', () => {
  const processes = [{ pid: 11, group: 10, state: 'S' }, { pid: 12, group: 10, state: 'Z' }, { pid: 21, group: 20, state: 'S' }];
  assert.deepEqual(liveOwnedProcesses([{ pid: 10 }], processes), [processes[0]]);
});
test('teardown kills real descendants and is idempotent, including a failed spawn', async t => {
  const root = temporary(t); const life = lifecycle(root, isolatedEnvironment(root)); t.after(() => life.close());
  const child = life.spawn(process.execPath, ['-e', `const child=require('node:child_process').spawn('sh',['-c','sleep 100']);child.once('spawn',()=>console.log('ready'));setInterval(()=>{},1000)`]);
  await new Promise(resolve => child.stdout.once('data', resolve));
  life.spawn('/does-not-exist', [], { name: 'missing' });
  await until(() => life.records[1].error, 'failed spawn');
  assert.deepEqual(await life.close(), []); assert.deepEqual(await life.close(), []);
  assert.throws(() => life.spawn('sh'), /after teardown/);
});
test('waits reject with useful bounded messages and free ports are allocated', async () => {
  const start = Date.now(); await assert.rejects(until(() => false, 'fixture checkpoint', 100), /fixture checkpoint/);
  assert.ok(Date.now() - start < 2000); assert.ok(await freePort() > 0);
  await assert.rejects(until(() => new Promise(() => {}), 'hung check', 50), /hung check.*did not settle/);
});
test('artifacts reject checkout and symlink descendants', t => {
  const root = temporary(t), checkout = join(root, 'repo'), external = join(root, 'artifacts');
  mkdirSync(checkout); mkdirSync(external); symlinkSync(checkout, join(root, 'alias'));
  assert.throws(() => outsideCheckout(checkout, checkout), /outside/);
  assert.throws(() => outsideCheckout(join(checkout, 'not-created-yet'), checkout), /outside/);
  assert.throws(() => outsideCheckout(join(root, 'alias'), checkout), /outside/);
  assert.doesNotThrow(() => outsideCheckout(external, checkout));
});
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) test(`${signal} cleans owned processes during target startup`, { timeout: 15000 }, async t => {
  const root = temporary(t);
  const entry = new URL('../index.mjs', import.meta.url).href;
  const source = `import {browserCheck} from ${JSON.stringify(entry)};
    await browserCheck({artifacts:${JSON.stringify(root)},target:async runtime=>{
      const child=runtime.spawn(runtime.node,['-e',"console.log('ready');setInterval(()=>{},1000)"]);
      child.stdout.once('data',()=>console.log('TARGET_READY'));
      return new Promise(()=>{});
    }});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  await until(() => output.includes('TARGET_READY'), 'target readiness', 5000);
  child.kill(signal);
  assert.equal(await exited, code);
  assert.match(output, /Processes left running: none/);
});
