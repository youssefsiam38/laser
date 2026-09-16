import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryLabels } from './process-sampler.mjs';

export function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dx = points[j].x - points[i].x;
    if (dx) slopes.push((points[j].y - points[i].y) / dx);
  }
  slopes.sort((a, b) => a - b);
  return slopes.length ? slopes[Math.floor(slopes.length / 2)] : null;
}

const formatSlopeNumber = value => Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(value)
  : 'unavailable';
const formatRSquared = value => Number.isFinite(value) ? value.toFixed(3) : 'unavailable';

export function slopeSummary(points, intervalSeconds, unit = 'bytes/unit') {
  const clean = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  const values = clean.map(point => point.y);
  const available = clean.length === points.length && points.length >= 3;
  const meanX = available ? clean.reduce((sum, point) => sum + point.x, 0) / clean.length : null;
  const meanY = available ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const sxx = available ? clean.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0) : 0;
  const syy = available ? clean.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0) : 0;
  const estimate = available && sxx > 0
    ? clean.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / sxx
    : null;
  const intercept = estimate === null ? null : meanY - estimate * meanX;
  const residualSumSquares = estimate === null ? null
    : clean.reduce((sum, point) => sum + (point.y - (intercept + estimate * point.x)) ** 2, 0);
  const residualStandardDeviation = residualSumSquares === null ? null : Math.sqrt(residualSumSquares / (clean.length - 2));
  const standardError = residualStandardDeviation === null || sxx <= 0 ? null : residualStandardDeviation / Math.sqrt(sxx);
  const rSquared = residualSumSquares === null || syy === 0 ? null : 1 - residualSumSquares / syy;
  const unresolved = estimate !== null && Number.isFinite(standardError) && Math.abs(estimate) <= 2 * standardError;
  const status = estimate === null ? 'unavailable' : unresolved ? 'unresolved' : 'resolved';
  const resolutionLimit = unresolved ? 2 * standardError : null;
  const display = status === 'unresolved'
    ? `no drift resolved above ±${formatSlopeNumber(resolutionLimit)} ${unit} (n=${clean.length}, R²=${formatRSquared(rSquared)})`
    : status === 'resolved' ? `${formatSlopeNumber(estimate)} ${unit}` : 'unavailable';
  return {
    status, display, estimator: 'ordinary-least-squares', measurementPhase: 'post-gc', unit,
    // D-267 keeps an unresolved slope from being displayed as a rate. D-269
    // retains the point estimate separately so a mixed pair can apply T2's
    // original sign/CV gate without changing either run's resolution label.
    value: status === 'resolved' ? estimate : null,
    estimate, estimateSource: 'reported',
    resolutionLimit, intercept, standardError, residualStandardDeviation,
    relativeStandardError: standardError === null || estimate === 0 ? null : standardError / Math.abs(estimate),
    rSquared, samples: points.length, points: clean.map(point => ({ x: point.x, y: point.y })),
    intervalSeconds,
    minimumBytes: values.length ? Math.min(...values) : null,
    maximumBytes: values.length ? Math.max(...values) : null,
    medianBytes: values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null,
  };
}

function mergedRanks(rows) {
  const merged = new Map();
  for (const row of rows ?? []) {
    const owner = sanitizeOwner(row.owner);
    merged.set(owner, Math.max(merged.get(owner) ?? 0, Number(row.bytes) || 0));
  }
  return [...merged].map(([owner, bytes]) => ({ owner, bytes })).sort((a, b) => b.bytes - a.bytes);
}
export function rankNames(rows, count = 10) { return mergedRanks(rows).slice(0, count).map(row => row.owner); }
export function spearman(a, b) {
  const common = a.filter(value => b.includes(value));
  if (common.length < 2) return null;
  const ar = common.toSorted((left, right) => a.indexOf(left) - a.indexOf(right));
  const br = common.toSorted((left, right) => b.indexOf(left) - b.indexOf(right));
  let d2 = 0;
  for (const value of common) d2 += (ar.indexOf(value) - br.indexOf(value)) ** 2;
  return 1 - (6 * d2) / (common.length * (common.length ** 2 - 1));
}

// V8 heap snapshots report retained self sizes in 8-byte units. Repeated
// captures of the same low-size WorkerServer owner varied by at most 1.22% in
// the two full validity runs, so the next quarter-percent is the declared
// comparison resolution. This changes ranks, never bytes or gate thresholds.
export const HEAP_RANK_RESOLUTION = Object.freeze({ absoluteBytes: 8, relative: 0.0125 });
const HEAP_RANK_CATEGORIES = new Set(['host', 'host-nodes', 'renderer', 'renderer-nodes', 'worker', 'worker-nodes']);

function tiedRanks(rows, category) {
  const ranked = mergedRanks(rows).slice(0, 10);
  if (!HEAP_RANK_CATEGORIES.has(category)) return ranked.map((row, index) => ({ ...row, rank: index + 1 }));
  const result = [];
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    const high = ranked[start].bytes;
    const tolerance = Math.max(HEAP_RANK_RESOLUTION.absoluteBytes, high * HEAP_RANK_RESOLUTION.relative);
    while (end < ranked.length && high - ranked[end].bytes <= tolerance) end += 1;
    const averageRank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index++) result.push({ ...ranked[index], rank: averageRank });
    start = end;
  }
  return result;
}

function spearmanWithTies(a, b) {
  const br = new Map(b.map(row => [row.owner, row.rank]));
  const common = a.filter(row => br.has(row.owner));
  if (common.length < 2) return null;
  const av = common.map(row => row.rank);
  const bv = common.map(row => br.get(row.owner));
  const am = av.reduce((sum, value) => sum + value, 0) / av.length;
  const bm = bv.reduce((sum, value) => sum + value, 0) / bv.length;
  let covariance = 0, aa = 0, bb = 0;
  for (let index = 0; index < av.length; index++) {
    const ax = av[index] - am, bx = bv[index] - bm;
    covariance += ax * bx; aa += ax * ax; bb += bx * bx;
  }
  if (aa === 0 || bb === 0) return aa === bb && av.every((value, index) => value === bv[index]) ? 1 : null;
  return covariance / Math.sqrt(aa * bb);
}
function sign(value) { return value === 0 ? 0 : value > 0 ? 1 : -1; }
function estimateFromPoints(points) {
  const clean = (points ?? []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length < 3) return null;
  const meanX = clean.reduce((sum, point) => sum + point.x, 0) / clean.length;
  const meanY = clean.reduce((sum, point) => sum + point.y, 0) / clean.length;
  const sxx = clean.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return sxx > 0 ? clean.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / sxx : null;
}
function slopeState(value) {
  if (typeof value === 'number') return { status: 'resolved', value, estimate: value, estimateSource: 'legacy-value' };
  if (!value || value.status === 'unavailable') return { status: 'unavailable', value: null, estimate: null };
  const reported = Number.isFinite(value.estimate) ? value.estimate : null;
  const retained = reported ?? estimateFromPoints(value.points);
  const estimateSource = reported !== null ? (value.estimateSource ?? 'reported')
    : Number.isFinite(retained) ? 'retained-points' : Number.isFinite(value.value) ? 'legacy-value' : null;
  const estimate = Number.isFinite(retained) ? retained : Number.isFinite(value.value) ? value.value : null;
  const common = { residualStandardDeviation: value.residualStandardDeviation, standardError: value.standardError,
    rSquared: value.rSquared, samples: value.samples, resolutionLimit: value.resolutionLimit, display: value.display,
    estimate, estimateSource };
  if (value.status === 'unresolved') return { ...common, status: 'unresolved', value: null };
  return Number.isFinite(estimate) ? { ...common, status: 'resolved', value: estimate } : { ...common, status: 'unavailable', value: null };
}
function coefficientOfVariation(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const meanMagnitude = (Math.abs(a) + Math.abs(b)) / 2;
  return meanMagnitude ? Math.abs(Math.abs(a) - Math.abs(b)) / (Math.SQRT2 * meanMagnitude) : 0;
}

/**
 * Predeclared, category-specific repeatability. Retained-heap owners, the
 * renderer's own state projection and Chrome's native allocator names are
 * structural: the same run twice must name the same top owner in the same
 * order, and a difference there is a real failure. Sampled allocation profiles
 * and desktop process rows are evidence of where allocation happens, drawn from
 * a statistical sampler, so they are still gated — the same owners must keep
 * showing up in the same broad order — but one noisy top symbol cannot fail a
 * run on its own. Categories are declared here, before any run; anything new is
 * strict until someone decides otherwise.
 */
export const COMPARISON_POLICY = Object.freeze({
  // A structural category can legitimately have only a handful of owners — one
  // retained target per heap phase, for instance — so the overlap it must show
  // is capped by how many owners exist rather than assumed to be five. What is
  // never relaxed: the same top owner, and rank correlation.
  strict: Object.freeze({ kind: 'strict', requireSameTopOwner: true, minimumTopFiveOverlap: 4, minimumSpearman: 0.8, minimumOwners: 1 }),
  evidence: Object.freeze({ kind: 'evidence', requireSameTopOwner: false, minimumTopFiveOverlap: 3, minimumSpearman: 0.4, minimumOwners: 5 }),
});

/**
 * Resolved slopes repeat when they point the same way and stay within a declared
 * spread. D-267 treats |slope| <= 2·SE as unresolved: two unresolved slopes are
 * an equivalent null only when their residual-noise floors also repeat within
 * the same 25% CV. D-269 judges a mixed pair by the original T2 sign/CV gate on
 * its retained OLS point estimates while preserving both resolution labels.
 */
export const SLOPE_POLICY = Object.freeze({ maximumCoefficientOfVariation: 0.25, unresolvedStandardErrors: 2 });
export const EVIDENCE_CATEGORIES = Object.freeze(['host-allocation', 'worker-allocation', 'desktop-processes']);
export function policyFor(category) {
  return EVIDENCE_CATEGORIES.includes(category) ? COMPARISON_POLICY.evidence : COMPARISON_POLICY.strict;
}

export function compareRuns(a, b) {
  const categories = {};
  for (const name of [...new Set([...Object.keys(a.rankings ?? {}), ...Object.keys(b.rankings ?? {})])]) {
    const policy = policyFor(name);
    const rankedA = tiedRanks(a.rankings?.[name] ?? [], name);
    const rankedB = tiedRanks(b.rankings?.[name] ?? [], name);
    const ar = rankedA.map(row => row.owner);
    const br = rankedB.map(row => row.owner);
    const overlap = ar.slice(0, 5).filter(owner => br.slice(0, 5).includes(owner)).length;
    const correlation = spearmanWithTies(rankedA, rankedB);
    const common = ar.filter(owner => br.includes(owner)).length;
    const enough = ar.length >= policy.minimumOwners && br.length >= policy.minimumOwners;
    const topOwnerSame = ar[0] !== undefined && ar[0] === br[0];
    const requiredOverlap = Math.min(policy.minimumTopFiveOverlap, ar.length, br.length);
    // Rank correlation needs two ranks. A structural category that legitimately
    // has one owner — a single merged retained target, say — repeats when that
    // one owner is the same in both runs, and there is no order left to get
    // wrong; with two or more owners the correlation threshold applies as usual.
    const trivial = correlation === null && common === 1 && topOwnerSame;
    const correlationOk = trivial || (correlation ?? -1) >= policy.minimumSpearman;
    categories[name] = {
      policy: policy.kind, topOwnerSame, topFiveOverlap: overlap, requiredOverlap, spearman: correlation,
      commonOwners: common, rankStability: trivial ? 'trivial: one common owner' : correlation === null ? 'unavailable' : 'correlated',
      owners: { a: ar.length, b: br.length },
      rankResolution: HEAP_RANK_CATEGORIES.has(name) ? HEAP_RANK_RESOLUTION : null,
      pass: enough && (policy.requireSameTopOwner ? topOwnerSame : true) && overlap >= requiredOverlap && correlationOk,
    };
  }
  const slopes = {};
  for (const name of [...new Set([...Object.keys(a.slopes ?? {}), ...Object.keys(b.slopes ?? {})])]) {
    const ar = slopeState(a.slopes?.[name]);
    const br = slopeState(b.slopes?.[name]);
    const common = { available: ar.status !== 'unavailable' && br.status !== 'unavailable',
      runs: { a: ar, b: br }, maximumCoefficientOfVariation: SLOPE_POLICY.maximumCoefficientOfVariation };
    if (ar.status === 'unresolved' && br.status === 'unresolved') {
      const floorCv = coefficientOfVariation(ar.residualStandardDeviation, br.residualStandardDeviation);
      const withinSpread = floorCv !== null && floorCv <= SLOPE_POLICY.maximumCoefficientOfVariation;
      slopes[name] = { ...common, outcome: 'equivalent-null', signAgrees: null, coefficientOfVariation: null,
        noiseFloorCoefficientOfVariation: floorCv, flaggedOver25Percent: floorCv !== null && !withinSpread,
        display: `equivalent null; A: ${ar.display}; B: ${br.display}; residual-SD CV=${floorCv ?? 'unavailable'}`,
        pass: common.available && withinSpread };
      continue;
    }
    if (ar.status === 'unresolved' || br.status === 'unresolved') {
      const estimatesAvailable = Number.isFinite(ar.estimate) && Number.isFinite(br.estimate);
      const cv = estimatesAvailable ? coefficientOfVariation(ar.estimate, br.estimate) : null;
      const signAgrees = estimatesAvailable ? sign(ar.estimate) === sign(br.estimate) : null;
      const withinSpread = cv !== null && cv <= SLOPE_POLICY.maximumCoefficientOfVariation;
      slopes[name] = { ...common, available: estimatesAvailable, outcome: 'mixed-resolution-point-estimates',
        signAgrees, coefficientOfVariation: cv, noiseFloorCoefficientOfVariation: null,
        flaggedOver25Percent: cv !== null && !withinSpread,
        display: `mixed resolution; A=${ar.status} (${formatSlopeNumber(ar.estimate)}; SE=${formatSlopeNumber(ar.standardError)}; R²=${formatRSquared(ar.rSquared)}); B=${br.status} (${formatSlopeNumber(br.estimate)}; SE=${formatSlopeNumber(br.standardError)}; R²=${formatRSquared(br.rSquared)}); sign agrees=${signAgrees}; CV=${cv ?? 'unavailable'}`,
        pass: estimatesAvailable && signAgrees && withinSpread };
      continue;
    }
    const available = ar.status === 'resolved' && br.status === 'resolved';
    const cv = available ? coefficientOfVariation(ar.value, br.value) : null;
    const withinSpread = cv !== null && cv <= SLOPE_POLICY.maximumCoefficientOfVariation;
    slopes[name] = { ...common, available, outcome: available ? 'resolved-pair' : 'unavailable',
      signAgrees: available ? sign(ar.value) === sign(br.value) : null, coefficientOfVariation: cv,
      noiseFloorCoefficientOfVariation: null,
      flaggedOver25Percent: cv !== null && !withinSpread,
      display: available ? `resolved pair; sign agrees=${sign(ar.value) === sign(br.value)}; CV=${cv}` : 'unavailable',
      pass: available && sign(ar.value) === sign(br.value) && withinSpread };
  }
  const scenariosComplete = [a, b].every(run => Object.values(run.scenarios ?? {}).every(value => value === 'complete'));
  return {
    pass: scenariosComplete && Object.keys(categories).length > 0 && Object.values(categories).every(value => value.pass)
      && Object.keys(slopes).length > 0 && Object.values(slopes).every(value => value.pass),
    policy: { strict: COMPARISON_POLICY.strict, evidence: COMPARISON_POLICY.evidence, evidenceCategories: EVIDENCE_CATEGORIES, slopes: SLOPE_POLICY },
    scenariosComplete, categories, slopes,
  };
}

const FORBIDDEN = [
  /(?:file:\/\/)?\/(?:home|Users|tmp)\/[\w./@~-]+/g,
  /(?:https?|ws):\/\/[^\s"']+/g,
  /data:image\/[^;]+;base64,/g,
  /[A-Za-z0-9+/]{512,}={0,2}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  /RESOURCE-SOAK-(?:PROMPT|COMMAND)-CANARY/g,
  /(?:authorization|api[_-]?key|token|password)["'\s:=]+[^\s,}"']+/gi,
  /(?:\.jsonl|\.heapsnapshot)\b/g,
  // A bare transcript basename is an identity even without its directory: the
  // settle timeout used to carry one into a report.
  /\bsession-[A-Za-z0-9_-]{4,}/g,
];
export function assertRedacted(text) {
  for (const pattern of FORBIDDEN) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) throw new Error(`Unsafe resource report content matched ${pattern}: ${match[0].slice(0, 60)}`);
  }
}
/**
 * The one place a label becomes safe. Every owner, phase name and error message
 * goes through this on the way *into* the report, so JSON and Markdown carry
 * the same sanitized text and a later renderer cannot reintroduce an identity.
 */
export function sanitizeOwner(value) {
  return String(value)
    .replace(/(?:file:\/\/)?\/(?:home|Users|tmp|private|var)\/[\w./@~-]+/g, '<path>')
    .replace(/\bsession-[A-Za-z0-9_-]{4,}(?:\.jsonl)?/g, '<session>')
    .replace(/\b[\w-]+\.(?:jsonl|heapsnapshot)\b/g, '<file>')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\bprocess \d+\b/g, 'a sampled process')
    .slice(0, 160);
}
/** Sanitize an error the run is about to record, message only, never a stack. */
export function sanitizeError(error) {
  return sanitizeOwner(error instanceof Error ? error.message : String(error));
}

export async function writeReport(root, report) {
  const safe = { schemaVersion: 1, ...report, memoryLabels: memoryLabels() };
  const json = `${JSON.stringify(safe, null, 2)}\n`;
  assertRedacted(json);
  const md = markdown(safe);
  assertRedacted(md);
  await Promise.all([
    writeFile(join(root, 'report.json'), json, { mode: 0o600 }),
    writeFile(join(root, 'report.md'), md, { mode: 0o600 }),
  ]);
  return safe;
}
function markdown(report) {
  const lines = [
    `# Resource soak — ${report.mode}`, '', `Implementation: \`${report.implementationSha}\``, '',
    'PSS apportions shared resident pages. Private resident is reported separately. RSS includes shared mappings at full size and is never summed as physical use.',
    'JavaScript heap, V8 external memory, native allocator totals and logical decoded-image bytes can overlap and are never presented as disjoint buckets.',
    'Totals cover the sampled scope only — the host process tree plus the renderer of the measured page — and each phase lists what it included and excluded.', '',
    `Result: **${report.pass ? 'pass' : 'incomplete'}**`, '', '## Scenarios', '',
    ...Object.entries(report.scenarios ?? {}).map(([name, value]) => `- ${name}: ${value}`), '',
  ];
  for (const phase of report.phases ?? []) {
    lines.push(`- ${phase.name}: PSS ${phase.totalPssBytes ?? 'unavailable'}; private resident ${phase.totalPrivateResidentBytes ?? 'unavailable'};`
      + ` JS heap ${phase.renderer?.jsHeapUsedBytes ?? 'unavailable'}; coverage ${phase.coverage?.complete ? 'complete' : 'incomplete'}`
      + ` (${phase.coverage?.measured ?? 0}/${phase.coverage?.expected ?? 0} expected processes)`);
  }
  lines.push('', '## Retained owner rankings', '');
  for (const [category, rows] of Object.entries(report.rankings ?? {})) {
    lines.push(`### ${category} (${policyFor(category).kind})`, ...mergedRanks(rows).slice(0, 10).map((row, index) => `${index + 1}. \`${row.owner}\` — ${row.bytes} bytes`), '');
  }
  lines.push('## Slopes', '', ...Object.entries(report.slopes ?? {}).map(([name, value]) => `- ${name}: ${typeof value === 'number' ? value : value?.display ?? 'unavailable'}`), '',
    '## Capabilities and limitations', '', ...Object.entries(report.capabilities ?? {}).map(([name, value]) => `- ${name}: ${value}`),
    ...(report.unsupported ?? []).map(value => `- unavailable: ${value}`), '',
    'Raw heap snapshots, memory traces, inspector registrations, URLs, scratch paths, session identifiers, commands and payloads are deliberately omitted.', '');
  return `${lines.join('\n')}\n`;
}

export async function scanArtifacts(files) {
  for (const file of files) assertRedacted(await readFile(file, 'utf8'));
}
