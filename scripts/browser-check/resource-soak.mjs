#!/usr/bin/env node
/**
 * The controlled RP-2 resource soak: a credential-free Linux scratch host, a
 * loopback provider, synthetic transcripts, and one measurement pass per
 * scenario. This file owns the run — argument handling, the report, the
 * scenario order, the two-run comparison and the artifact gates. What each
 * scenario does lives in `resource/scenarios/`, and how a phase is measured
 * lives in `resource/`.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { browserCheck } from './index.mjs';
import { resourceTarget, fixture, checkout } from './targets/resource-soak.mjs';
import { modeConfig, expected, SAFETY } from './resource/config.mjs';
import { enforceSafety } from './resource/process-sampler.mjs';
import { runElectronLane } from './resource/electron.mjs';
import { SoakRun, moduleUrls, closedPageMetrics } from './resource/context.mjs';
import { BROWSER_SCENARIOS, DESKTOP_SCENARIO, SCENARIO_IDS } from './resource/scenarios/index.mjs';
import { setCategory } from './resource/rankings.mjs';
import { writeReport, compareRuns, assertRedacted, sanitizeError, sanitizeOwner, scanArtifacts } from './resource/report.mjs';

const modules = moduleUrls(checkout);

/**
 * Exactly the provider traffic this run asked for. Anything the engine issues
 * on its own — a title, a summary — is counted separately as engine-internal
 * evidence rather than folded into a harness route.
 */
export function providerAccounting(value, config, exp) {
  const buckets = { seed: 0, largeStream: 0, largeTool: 0, images: 0, childStart: 0, child: 0, bash: 0, engineInternal: 0 };
  for (const [name, count] of Object.entries(value.routes ?? {})) {
    const bucket = name.startsWith('seed:') ? 'seed'
      : name.startsWith('resource:large-stream') ? 'largeStream'
      : name.startsWith('resource:tool-large') ? 'largeTool'
      : name.startsWith('resource:images') ? 'images'
      : name.startsWith('resource:start-child') ? 'childStart'
      : name.startsWith('resource:child') ? 'child'
      : name.startsWith('resource:bash') ? 'bash'
      : name.startsWith('resource:reattached') ? 'reattached'
      : 'engineInternal';
    buckets[bucket] = (buckets[bucket] ?? 0) + (Number(count) || 0);
  }
  // A prompt that ends in a tool call costs two provider requests: the call and
  // the continuation that reads its result.
  const expectedCounts = {
    seed: exp.seedRequests,
    largeStream: 2,
    largeTool: 2,
    images: 1,
    childStart: config.children * 2,
    bash: exp.bashCalls * 2,
    reattached: 1,
  };
  const mismatches = Object.entries(expectedCounts)
    .filter(([name, count]) => (buckets[name] ?? 0) !== count)
    .map(([name, count]) => `${name}: expected ${count}, saw ${buckets[name] ?? 0}`);
  return { requests: value.requests, buckets, expectedCounts, mismatches,
    childRuns: { observed: buckets.child, started: config.children },
    lastToolCount: Array.isArray(value.lastToolNames) ? value.lastToolNames.length : 0 };
}

/** What a failed run is allowed to keep: completed work, counts and the refusal, never an identity. */
export function partialFailureReport(report, error, evidence = null) {
  const { startedAtMs: _startedAtMs, ...rest } = report;
  return { ...rest, pass: false,
    failure: {
      message: sanitizeError(error),
      phasesCompleted: report.phases.length,
      phaseNames: report.phases.map(phase => sanitizeOwner(phase.name)),
      scenarios: { ...report.scenarios },
      safetyRefusal: report.safetyRefusal ?? null,
      survivors: evidence?.survivors?.length ?? null,
    } };
}

/** Atomic, redaction-gated write. A partial report never half-exists. */
export async function writeAtomicJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertRedacted(text);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

/**
 * A refusal to write a partial report is itself evidence and must reach the
 * operator: the unsafe body is dropped, and a safe marker records that it was
 * refused and why, so a redaction failure can never be mistaken for a run that
 * simply produced nothing.
 */
export async function writePartialReport(artifacts, report, error, teardown, { write = writeAtomicJson } = {}) {
  const path = join(artifacts, 'report-partial.json');
  try {
    await write(path, partialFailureReport(report, error, teardown));
    return { written: true, path };
  } catch (refusal) {
    const marker = { schemaVersion: 1, partialReport: 'refused',
      reason: sanitizeError(refusal),
      failure: sanitizeError(error),
      phasesCompleted: report.phases?.length ?? 0,
      survivors: teardown?.survivors?.length ?? null };
    try {
      await write(join(artifacts, 'report-partial-refused.json'), marker);
      return { written: false, refused: true, reason: marker.reason };
    } catch {
      return { written: false, refused: true, reason: 'the refusal marker could not be written either' };
    }
  }
}

async function runBrowserSoak(check, mode, report) {
  const config = modeConfig(mode);
  const exp = expected(config);
  const run = new SoakRun(check, { config, expected: exp, report, modules, mode, checkout });
  const browserVersion = await check.browserCdp.send('Browser.getVersion');
  report.runtime = { node: process.versions.node, chrome: browserVersion.product, platform: process.platform, architecture: process.arch };
  report.fixture = { mode: config.name, projects: config.projects, sessionsPerProject: config.sessionsPerProject, longSessions: config.longSessions,
    longMessages: config.longMessages, children: config.children, foregroundCalls: config.foregroundCalls,
    backgroundCalls: config.backgroundCalls, images: config.images, imageSide: config.imageSide,
    reasoningBytes: config.reasoningBytes, markdownBytes: config.markdownBytes, toolBytes: config.toolBytes,
    retainedViews: exp.retainedViews, workers: exp.workers, desktopLaneMode: config.electronLaneMode,
    snapshotByteCeiling: SAFETY.snapshotBytes, processPssCeiling: SAFETY.processPssBytes,
    totalPssCeiling: SAFETY.totalPssBytes, minimumAvailableBytes: SAFETY.minimumAvailableBytes };
  report.capabilities = { linuxProc: 'available', nodeInspector: 'available', rendererCdp: 'available',
    physicalDecodedImageOwnership: 'unavailable', relayConsumer: 'not measured; local host WebSocket backpressure only' };

  for (const scenario of BROWSER_SCENARIOS) {
    // A measurement-only run stops after a named scenario. The fixture, the
    // workload, the ceilings and the safety verdict are untouched: only the
    // number of scenarios reached changes, and the report says which ones it
    // never ran so it can never read as a baseline.
    if (report.stoppedAfter !== undefined) {
      for (const id of scenario.ids ?? [scenario.id]) report.scenarios[id] = 'not-run: measurement-only run stopped earlier';
      continue;
    }
    const result = await scenario.run(run);
    // "Complete" means measured: the scenario has to hand back the phase sample
    // that is already in the report.
    assert.ok(result?.phase && report.phases.includes(result.phase), `${scenario.id} finished without a phase sample of its own`);
    Object.assign(run.state, result.state ?? {});
    for (const id of scenario.ids ?? [scenario.id]) report.scenarios[id] = 'complete';
    if (report.until && (scenario.ids ?? [scenario.id]).includes(report.until)) report.stoppedAfter = scenario.id;
  }

  // Discovery is reported from what was actually proved by a query, never from
  // a constant.
  report.discovery = {
    hostServer: run.discovery.proved('HostServer'),
    workerServer: run.discovery.proved('WorkerServer'),
    rendererStore: run.state.rendererStoreProved === true,
    tailBuffer: run.state.tailBufferProjectionProved === true,
    tailBufferCountAtCheckpoint: run.state.tailBufferCount ?? null,
    queryObjectsCheckpoints: run.discovery.checkpoints().length,
    note: 'TailBuffer projection was queried after a real tool call; zero instances is the required post-terminal RP-6 result. Runtime.queryObjects runs once per process generation; later phases read the handle it published',
  };
  // A measurement-only run proves what the scenarios it ran can prove. The
  // TailBuffer projection is proved after the real tool call in scenario 4;
  // a run stopped earlier says "not reached" rather than claiming or failing.
  if (report.stoppedAfter !== undefined) report.discovery.tailBuffer = 'not reached in this measurement-only run';
  assert.ok(report.discovery.hostServer && report.discovery.workerServer && report.discovery.rendererStore
    && (report.stoppedAfter !== undefined || report.discovery.tailBuffer),
    `runtime discovery was not proved: ${JSON.stringify(report.discovery)}`);
  return run;
}

async function oneRun(mode, artifacts, implementationSha, electron, until) {
  const config = modeConfig(mode);
  const exp = expected(config);
  const report = { mode, implementationSha, startedAtMs: Date.now(), phases: [], rankings: {}, slopes: {}, scenarios: {},
    unsupported: ['physical decoded-image bytes per DOM owner', 'relay-client memory in the local stalled-reader lane'], pass: false,
    ...(until ? { until, purpose: 'calibration', partial: true } : {}) };
  let evidence;
  try {
    evidence = await browserCheck({ checkout, target: resourceTarget(mode), fixture, fixtureName: mode, artifacts, timeout: config.phaseTimeoutMs },
      check => runBrowserSoak(check, mode, report));
  } catch (error) {
    // Teardown has already run and written its evidence; read the survivor
    // outcome when it is there, then keep what the run did prove.
    let teardown = null;
    try {
      const roots = (await readdir(artifacts, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('run-'));
      const candidates = await Promise.all(roots.map(async entry => {
        try { return JSON.parse(await readFile(join(artifacts, entry.name, 'evidence.json'), 'utf8')); } catch { return null; }
      }));
      teardown = candidates.filter(Boolean).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).at(-1);
    } catch {}
    const partial = await writePartialReport(artifacts, report, error, teardown);
    if (partial.refused) console.error(`Partial report refused by redaction: ${partial.reason}`);
    throw error;
  }
  report.build = evidence.build;
  const counters = JSON.parse(await readFile(join(evidence.root, 'provider-counters.json'), 'utf8'));
  report.provider = providerAccounting(counters, config, exp);
  // The accounting is of the whole workload; a run that stopped early has not
  // executed all of it, so its differences are recorded, not asserted.
  if (until) report.provider.partial = true;
  else assert.deepEqual(report.provider.mismatches, [], `provider route accounting did not match the workload: ${report.provider.mismatches.join('; ')}`);
  report.survivors = evidence.survivors.length;
  const evidenceSummary = { survivors: evidence.survivors.length };
  if (evidence.survivors.length === 0) await rm(evidence.root, { recursive: true, force: true });
  if (electron) {
    report.desktop = await runElectronLane({ checkout, root: artifacts, mode: config.electronLaneMode, timeoutMs: config.phaseTimeoutMs });
    report.scenarios[DESKTOP_SCENARIO] = 'complete';
    setCategory(report.rankings, 'desktop-processes', ['visible', 'hidden', 'restored'].flatMap(name =>
      report.desktop[name].processes.map(row => ({ owner: `${name}/${row.role}`, bytes: row.pssBytes ?? 0 }))));
    report.capabilities.electron = `available; declared lane scale ${config.electronLaneMode}`;
  } else {
    report.scenarios[DESKTOP_SCENARIO] = 'quick-mode-not-requested';
    report.capabilities.electron = 'not requested in quick mode';
  }
  report.pass = report.survivors === 0
    && Object.entries(report.scenarios).every(([name, value]) => name === DESKTOP_SCENARIO ? (electron ? value === 'complete' : mode === 'quick') : value === 'complete');
  if (until) {
    // Measurement only. A run that did not execute every scenario is never a
    // pass and never a baseline, whatever its phases measured.
    report.remainingScenarios = Object.entries(report.scenarios)
      .filter(([, value]) => value !== 'complete').map(([name]) => name).sort();
    report.pass = false;
  }
  report.startedAtMs = undefined;
  return { report, evidence: evidenceSummary };
}

function comparisonMarkdown(implementationSha, comparison) {
  return `# Resource soak comparison\n\nImplementation: \`${implementationSha}\`\n\nResult: **${comparison.pass ? 'pass' : 'failed'}**\n\n`
    + `Categories are gated by a predeclared policy: structural owners strictly, sampled evidence loosely.\n\n`
    + Object.entries(comparison.categories).map(([name, value]) => `- ${name} (${value.policy}): top=${value.topOwnerSame}; overlap=${value.topFiveOverlap}/5; Spearman=${value.spearman ?? 'unavailable'}; pass=${value.pass}`).join('\n')
    + `\n\n## Slopes\n\n` + Object.entries(comparison.slopes).map(([name, value]) => `- ${name}: ${value.display}; pass=${value.pass}`).join('\n') + '\n';
}

async function writeComparisonArtifacts(artifacts, implementationSha, comparison) {
  const text = `${JSON.stringify({ implementationSha, ...comparison }, null, 2)}\n`;
  const markdown = comparisonMarkdown(implementationSha, comparison);
  assertRedacted(text); assertRedacted(markdown);
  await Promise.all([
    writeFile(join(artifacts, 'comparison.json'), text, { mode: 0o600 }),
    writeFile(join(artifacts, 'comparison.md'), markdown, { mode: 0o600 }),
  ]);
}

/** Recompute only the A/B verdict from retained sanitized reports; never run a workload. */
export async function compareRetainedRuns({ artifacts }) {
  const [aText, bText] = await Promise.all([
    readFile(join(artifacts, 'run-a', 'report.json'), 'utf8'),
    readFile(join(artifacts, 'run-b', 'report.json'), 'utf8'),
  ]);
  assertRedacted(aText); assertRedacted(bText);
  const a = JSON.parse(aText), b = JSON.parse(bText);
  assert.equal(a.implementationSha, b.implementationSha, 'retained reports must describe the same implementation');
  const implementationSha = a.implementationSha;
  const comparison = compareRuns(a, b);
  await writeComparisonArtifacts(artifacts, implementationSha, comparison);
  const manifestPath = join(artifacts, 'manifest.json');
  const manifestText = await readFile(manifestPath, 'utf8').catch(() => null);
  if (manifestText !== null) {
    assertRedacted(manifestText);
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.implementationSha, implementationSha, 'retained manifest must match the reports');
    const updated = `${JSON.stringify({ ...manifest, comparisonPolicy: comparison.policy, comparisonPassed: comparison.pass }, null, 2)}\n`;
    assertRedacted(updated);
    await writeFile(manifestPath, updated, { mode: 0o600 });
  }
  return { implementationSha, comparison };
}

export async function runResourceSoak({ mode = 'quick', runs = 1, artifacts = '/tmp/resource-soak', electron = false, until } = {}) {
  if (process.platform !== 'linux') throw new Error('The full resource soak requires Linux /proc PSS accounting.');
  // Measurement-only calibration (RP-5): the unchanged full workload, stopped
  // after a named scenario. It is one run, it is never a baseline, and it can
  // never be combined with the two-run comparison the baseline is made of.
  if (until !== undefined) {
    if (!SCENARIO_IDS.includes(until)) throw new Error(`There is no scenario called ${until}.`);
    if (runs !== 1) throw new Error('A measurement-only run is exactly one run; it is not a baseline and has nothing to compare.');
  }
  if (mode === 'full' && until === undefined && runs !== 2) throw new Error('Full baseline evidence requires exactly two clean runs.');
  if (mode === 'full' && until === undefined && !electron) throw new Error('Full baseline evidence requires the real Electron hide/restore lane.');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const implementationSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  const results = [];
  for (let index = 0; index < runs; index++) {
    if (index === 1) {
      const first = results[0];
      if (!first.report.pass || first.report.survivors) throw new Error('Safety refusal: run A was not clean; run B will not start.');
      const last = first.report.phases.at(-1);
      await enforceSafety([]);
      if (last?.safety?.availableBytes !== null && last.safety.availableBytes < SAFETY.minimumAvailableBytes) {
        throw new Error('Safety refusal: run A ended below the memory-availability floor.');
      }
    }
    const root = join(artifacts, `run-${String.fromCharCode(97 + index)}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const result = await oneRun(mode, root, implementationSha, electron, until);
    await writeReport(root, result.report);
    results.push(result);
  }
  let comparison = null;
  if (results.length === 2) {
    comparison = compareRuns(results[0].report, results[1].report);
    await writeComparisonArtifacts(artifacts, implementationSha, comparison);
  }
  const manifest = { schemaVersion: 1, implementationSha, mode, runs, electron,
    ...(until ? { until, purpose: 'calibration', partial: true, remainingScenarios: results[0]?.report.remainingScenarios ?? null } : {}),
    build: results[0]?.report.build,
    runtime: results[0]?.report.runtime, fixture: results[0]?.report.fixture, capabilities: results[0]?.report.capabilities,
    comparisonPolicy: comparison?.policy ?? null,
    allRunsPassed: results.every(result => result.report.pass), comparisonPassed: comparison?.pass ?? null };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  assertRedacted(manifestText);
  await writeFile(join(artifacts, 'manifest.json'), manifestText, { mode: 0o600 });
  const scan = async directory => (await readdir(directory, { withFileTypes: true }))
    .flatMap(entry => entry.isDirectory() ? [] : /\.(?:json|md|log)$/.test(entry.name) ? [join(directory, entry.name)] : []);
  const finalFiles = [...await scan(artifacts)];
  for (const name of ['run-a', 'run-b']) if ((await readdir(join(artifacts, name)).catch(() => [])).length) finalFiles.push(...await scan(join(artifacts, name)));
  await scanArtifacts(finalFiles);
  return { implementationSha, results: results.map(({ report }) => report), comparison };
}

export { closedPageMetrics };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { quick: { type: 'boolean' }, full: { type: 'boolean' }, runs: { type: 'string' }, artifacts: { type: 'string' }, electron: { type: 'boolean' }, until: { type: 'string' }, 'compare-only': { type: 'boolean' } } });
  const mode = values.full ? 'full' : 'quick';
  if (values['compare-only']) {
    const result = await compareRetainedRuns({ artifacts: resolve(values.artifacts ?? `/tmp/resource-soak-${mode}`) });
    console.log(JSON.stringify({ implementationSha: result.implementationSha, pass: result.comparison.pass }, null, 2));
  } else {
    const result = await runResourceSoak({ mode, runs: Number(values.runs ?? (values.until ? 1 : mode === 'full' ? 2 : 1)), electron: values.electron ?? false,
      ...(values.until ? { until: values.until } : {}),
      artifacts: resolve(values.artifacts ?? `/tmp/resource-soak-${mode}`) });
    console.log(JSON.stringify({ implementationSha: result.implementationSha, pass: result.results.every(run => run.pass) && (result.comparison?.pass ?? true) }, null, 2));
  }
}
