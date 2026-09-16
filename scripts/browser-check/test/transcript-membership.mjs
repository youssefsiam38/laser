import assert from 'node:assert/strict';
import {
  callFunction,
  connectInspector,
  queryInstances,
  waitForRegistrations,
} from '../resource/inspector.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Real host + UI regression for default transcript membership (M18-T15).
 *
 * Run with:
 *   node scripts/browser-check/run.mjs --target scripts/browser-check/targets/transcript-membership.mjs --fixture long --script scripts/browser-check/test/transcript-membership.mjs
 *
 * The target combines the quick resource host with the ordinary long app
 * fixture and returns `hostRecord`, `inspectDir`, `path`, and `project`.
 * The inspector reads only the public
 * SessionMembershipView: counts(), paths(), and admittedHolders().
 */
export default async check => {
  const records = await waitForRegistrations(check.fixture.inspectDir, {
    rootPid: check.fixture.hostRecord.pid,
    minimum: 1,
  });
  const record = records.find(row => row.pid === check.fixture.hostRecord.pid);
  assert.ok(record, 'the owned host inspector is registered');
  const inspector = await connectInspector(record, {
    rootPid: check.fixture.hostRecord.pid,
    label: 'transcript-membership-host',
  });
  const moduleUrl = new URL('../../../packages/host/dist/index.js', import.meta.url).href;
  const queried = await queryInstances(inspector, moduleUrl, 'HostServer');
  assert.ok(queried.instanceId, 'the real HostServer is reachable');

  const membership = () => callFunction(inspector, queried.instanceId, `function(){
    const deliveries=Array.from(this.transcripts.values());
    let owners=0, admitted=0; const paths=new Set();
    for(const delivery of deliveries){
      owners+=delivery.counts().owners;
      for(const path of delivery.paths()){ paths.add(path); admitted+=delivery.admittedHolders(path); }
    }
    return { connections:this.clients.size, paths:paths.size, owners, admitted };
  }`, { returnByValue: true });
  const untilOne = async label => {
    const deadline = Date.now() + 20_000;
    let last;
    while (Date.now() < deadline) {
      last = await membership();
      if (last.connections === 1 && last.paths <= 1) return last;
      await sleep(100);
    }
    assert.fail(`${label}: canonical membership did not collapse; ${JSON.stringify(last)}`);
  };

  try {
    // Start from the real project landing composer. Its session is admitted
    // before assistant-ui adopts the remote id; the landing hold must bridge
    // that gap, keep membership bounded, and deliver the streamed first turn.
    await check.page.evaluate(() => {
      const soak = window.__resourceSoak;
      soak.stable.buildActions(soak.store.getSnapshot).leaveSession();
    });
    await check.page.waitForFunction(() => window.__resourceSoak.store.getSnapshot().current === undefined);
    const composer = check.page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.waitFor({ state: 'visible' });
    const prompt = 'membership landing first turn';
    const responsesBefore = await check.page.locator('[data-role="assistant"]').filter({ hasText: /synthetic response/ }).count();
    await composer.fill(prompt);
    await check.page.getByRole('main').getByRole('button', { name: 'Send', exact: true }).click();
    await check.page.waitForFunction(previous => {
      const current = window.__resourceSoak.store.getSnapshot().current;
      return typeof current === 'string' && current !== previous;
    }, check.fixture.path);
    const landingMembership = await membership();
    assert.equal(landingMembership.connections, 1);
    assert.ok(landingMembership.paths <= 1, `landing membership is bounded: ${JSON.stringify(landingMembership)}`);
    await check.page.locator('[data-role="user"]').filter({ hasText: prompt }).waitFor();
    await check.page.waitForFunction(before => [...document.querySelectorAll('[data-role="assistant"]')]
      .filter(node => /synthetic response/.test(node.textContent ?? '')).length > before, responsesBefore);
    const settledLanding = await untilOne('landing first turn');
    assert.ok(settledLanding.paths <= 1);

    // Establish the on-screen hold through the product client, then create a
    // second hydrated view without selecting it. Its default hold must leave.
    await check.page.evaluate(async path => window.__resourceSoak.stable.openSession(path), check.fixture.path);
    await untilOne('current load');
    const created = await check.rpc('session/new', { cwd: check.fixture.project });
    await check.page.evaluate(async path => window.__resourceSoak.stable.openSession(path), created.state.path);
    const background = await untilOne('background load');
    assert.ok(background.paths <= 1);

    // A fresh socket resumes HostClient's tracked paths outside provider
    // openSession. The resumed dormant hold must itself trigger another detach.
    await callFunction(inspector, queried.instanceId, `function(){
      for(const socket of Array.from(this.clients)) socket.close(1012,'membership regression reconnect');
    }`, { returnByValue: true });
    await check.page.getByText(/(?:Re)?[Cc]onnecting to the host…|Disconnected from the host/).first()
      .waitFor({ state: 'hidden', timeout: 20_000 });
    const resumed = await untilOne('reconnect resume');
    assert.ok(resumed.paths <= 1, 'TranscriptDelivery.counts().paths stays at most one after reconnect resume');
  } finally {
    await inspector.send('Runtime.releaseObjectGroup', { objectGroup: queried.group }).catch(() => {});
    await inspector.close().catch(() => {});
  }
};
