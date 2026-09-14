import assert from 'node:assert/strict';
import { selectSession } from '../sidebar.mjs';
import { slopeSummary } from '../report.mjs';

/** Scenario 3 — page backwards through the long transcripts. */
export default {
  id: '3-backward-pagination',
  title: 'page backwards through several long transcripts',
  async run(run) {
    const { check, config, expected, report, state } = run;
    const checkpoints = [{ pages: 0, rendererJsHeapBytes: state.distinctPhase?.renderer?.jsHeapUsedBytes ?? null }];
    let loadedPages = 0;
    for (const session of state.sessions.filter(session => session.messages === config.longMessages)) {
      await selectSession(check, session);
      for (let page = 0; page < expected.historyPages; page++) {
        const button = check.page.getByRole('button', { name: 'Load earlier messages', exact: true });
        if (!await button.isVisible().catch(() => false)) break;
        await button.click();
        await check.page.getByText('Loading earlier messages…').waitFor({ state: 'hidden' }).catch(() => {});
      }
      const entries = await check.rpc('pi/session/entries', { path: session.path });
      assert.equal(entries.entries.filter(entry => entry.type === 'message').length, session.messages);
      loadedPages += expected.historyPages;
      const checkpoint = await run.samplePhase(`paged-${session.alias}`);
      checkpoints.push({ pages: loadedPages, rendererJsHeapBytes: checkpoint.renderer?.jsHeapUsedBytes ?? null });
    }
    const phase = await run.samplePhase('paged-history', { heap: true });
    report.slopes.rendererPagedHistoryHeapBytesPerPage = slopeSummary(checkpoints.map(row => ({ x: row.pages, y: row.rendererJsHeapBytes })), null);
    return { phase, state: { pagedHistoryPhase: phase } };
  },
};
