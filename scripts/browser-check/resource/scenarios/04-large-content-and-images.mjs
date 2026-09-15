import assert from 'node:assert/strict';
import { imagePayload, prompt, settle } from '../fixtures.mjs';
import { selectSession } from '../sidebar.mjs';
import { captureMemoryInfra } from '../memory-infra.mjs';
import { setCategory } from '../rankings.mjs';
import { slopeSummary } from '../report.mjs';
import { tailBufferCounters } from '../inspector.mjs';

/** Scenario 4 — large reasoning, Markdown, tool output and images. */
export default {
  id: '4-large-content-and-images',
  title: 'stream large reasoning, Markdown, tool output and images',
  async run(run) {
    const { check, config, report, state } = run;
    const heavy = state.sessions[0];
    await selectSession(check, heavy);
    await prompt(check.rpc, heavy.path, 'resource:large-stream RESOURCE-SOAK-PROMPT-CANARY', run.until.bind(run), config.phaseTimeoutMs);
    const afterReasoning = await run.samplePhase('large-reasoning-markdown');
    await prompt(check.rpc, heavy.path, 'resource:tool-large', run.until.bind(run), config.phaseTimeoutMs);

    // The extension's tail buffers, read from the heap of the worker that would
    // be holding them. Before RP-6 a finished command kept its full 256 KiB
    // buffer for the life of the session, and this checkpoint asserted exactly
    // that. It now asserts the containment: the query still works (the
    // instrumentation is proved by a readable answer), and a command that has
    // ended is holding nothing. Live buffers are covered where a command can
    // be observed while it runs — `packages/pi-extension/test`.
    const tailCheckpoint = await run.inspectorSet();
    let tailBufferCount = 0;
    let tailBufferReadable = false;
    try {
      assert.ok(tailCheckpoint.workers.length >= 1, 'WorkerServer Runtime.queryObjects checkpoint found no live worker');
      for (const worker of tailCheckpoint.workers) {
        const counters = await tailBufferCounters(worker.client, run.modules.tail, { minimum: 0 });
        tailBufferReadable = true;
        tailBufferCount += counters.count;
      }
      assert.equal(tailBufferReadable, true, 'TailBuffer Runtime.queryObjects checkpoint could not be read after the first real tool call');
      assert.equal(tailBufferCount, 0, 'a finished command must keep no tail buffer (RP-6)');
    } finally { await run.closeInspectorSet(tailCheckpoint); }

    // The worker process holding that buffer right now: if it retires naturally
    // later, the buffer goes with it and the retention expectation must know.
    const heavyToolGeneration = await run.workerGeneration(heavy.cwd);
    const afterTool = await run.samplePhase('large-tool-output');

    const images = imagePayload(config);
    const accepted = await check.rpc('session/prompt', { path: heavy.path,
      content: [{ type: 'text', text: 'resource:images' }, ...images.map(image => ({ type: 'image', mimeType: 'image/png', data: image.bytes.toString('base64') }))] });
    assert.equal(accepted.accepted, true);
    await settle(check.rpc, heavy.path, run.until.bind(run), config.phaseTimeoutMs);
    await selectSession(check, heavy);
    const memoryInfra = await captureMemoryInfra(check.browserCdp, async () => {
      const imageRows = check.page.locator('[data-slot="message-image"]');
      await imageRows.evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())));
      await imageRows.first().click();
      await check.page.keyboard.press('Escape');
      await selectSession(check, state.sessions.at(-1));
      await selectSession(check, heavy);
      await imageRows.evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())));
    }, { timeoutMs: config.phaseTimeoutMs });
    report.memoryInfra = memoryInfra;
    report.capabilities.nativeAllocatorDump = memoryInfra.available
      ? `available; one bounded ${memoryInfra.levelOfDetail} dump outside the workload, ${memoryInfra.allocators.length} allocator owners`
      : `unavailable: ${memoryInfra.reason}`;
    setCategory(report.rankings, 'renderer-native-allocators', memoryInfra.allocators);

    const phase = await run.samplePhase('large-stream', { heap: true });
    report.slopes.rendererHeavyPayloadHeapBytesPerMiB = slopeSummary([
      { x: 0, y: state.distinctPhase?.renderer?.jsHeapUsedBytes ?? null },
      { x: (config.reasoningBytes + config.markdownBytes) / 1024 / 1024, y: afterReasoning.renderer?.jsHeapUsedBytes ?? null },
      { x: (config.reasoningBytes + config.markdownBytes + config.toolBytes) / 1024 / 1024, y: afterTool.renderer?.jsHeapUsedBytes ?? null },
    ], null);
    report.imageOwnership = { count: images.length, decodedCount: phase.renderer?.images?.filter(image => image.decoded).length ?? 0,
      logicalPixelBytes: images.reduce((n, image) => n + image.logicalBytes, 0), encodedBytes: images.reduce((n, image) => n + image.bytes.length, 0),
      hashes: images.map(image => image.hash), physicalDecodedBytes: null,
      limitation: 'logical RGBA estimate per decoded image; physical decode-cache ownership is unavailable' };
    assert.equal(report.imageOwnership.decodedCount, images.length, 'every synthetic message image decoded');
    report.temporaryPeaks.heavyRendererJsBytes = Number.isFinite(phase.postGc?.renderer?.jsHeapUsedBytes)
      ? Math.max(afterReasoning.renderer?.jsHeapUsedBytes ?? 0, afterTool.renderer?.jsHeapUsedBytes ?? 0, phase.renderer?.jsHeapUsedBytes ?? 0)
        - phase.postGc.renderer.jsHeapUsedBytes : null;
    return { phase, state: { heavy, heavyToolGeneration, tailBufferProjectionProved: tailBufferReadable, tailBufferCount, images: images.length } };
  },
};
