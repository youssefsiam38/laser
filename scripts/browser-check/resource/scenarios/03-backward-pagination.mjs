import assert from 'node:assert/strict';
import { selectSession } from '../sidebar.mjs';
import { slopeSummary } from '../report.mjs';

/** Scenario 3 — page backwards through the long transcripts. */
export default {
  id: '3-backward-pagination',
  title: 'page backwards through several long transcripts',
  async run(run) {
    const { check, config, expected, report, state } = run;
    const checkpoints = [{ pages: 0, rendererJsHeapBytes: state.distinctPostGcRendererHeapBytes ?? null, phase: 'post-gc' }];
    let loadedPages = 0;
    for (const session of state.sessions.filter(session => session.messages === config.longMessages)) {
      await selectSession(check, session);
      for (let page = 0; page < expected.historyPages; page++) {
        const button = check.page.getByRole('button', { name: 'Load earlier messages', exact: true });
        if (!await button.isVisible().catch(() => false)) break;
        await button.click();
        await check.page.getByText('Loading earlier messages…').waitFor({ state: 'hidden' }).catch(() => {});
        loadedPages += 1;
        const postGc = await run.rendererPostGcHeap(`paged-${session.alias}-${page + 1}`);
        checkpoints.push({ pages: loadedPages, rendererJsHeapBytes: postGc.rendererJsHeapBytes, phase: postGc.phase });
      }
      const entries = await check.rpc('pi/session/entries', { path: session.path });
      assert.equal(entries.entries.filter(entry => entry.type === 'message').length, session.messages);
      await run.samplePhase(`paged-${session.alias}`);
    }
    assert.equal(checkpoints.length, loadedPages + 1, 'every history-page workload step has exactly one post-GC slope sample');
    const phase = await run.samplePhase('paged-history', { heap: true });
    report.slopes.rendererPagedHistoryHeapBytesPerPage = slopeSummary(checkpoints.map(row => ({ x: row.pages, y: row.rendererJsHeapBytes })), null, 'bytes/page');
    return { phase, state: { pagedHistoryPhase: phase } };
  },
};
