import { createHash } from 'node:crypto';
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

export function slopeSummary(points, intervalSeconds) {
  const values = points.map(point => point.y).filter(Number.isFinite);
  return {
    status: values.length === points.length && points.length >= 3 ? 'available' : 'unavailable',
    value: values.length === points.length && points.length >= 3 ? theilSen(points) : null,
    samples: points.length,
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
function sign(value) { return value === 0 ? 0 : value > 0 ? 1 : -1; }
function slopeValue(value) { return typeof value === 'number' ? value : value?.value; }

export function compareRuns(a, b) {
  const categories = {};
  for (const name of [...new Set([...Object.keys(a.rankings ?? {}), ...Object.keys(b.rankings ?? {})])]) {
    const ar = rankNames(a.rankings?.[name] ?? []);
    const br = rankNames(b.rankings?.[name] ?? []);
    const overlap = ar.slice(0, 5).filter(owner => br.slice(0, 5).includes(owner)).length;
    const correlation = spearman(ar, br);
    const enough = ar.length >= 5 && br.length >= 5;
    categories[name] = {
      topOwnerSame: ar[0] === br[0], topFiveOverlap: overlap, spearman: correlation,
      pass: enough && ar[0] === br[0] && overlap >= 4 && (correlation ?? -1) >= 0.8,
    };
  }
  const slopes = {};
  for (const name of [...new Set([...Object.keys(a.slopes ?? {}), ...Object.keys(b.slopes ?? {})])]) {
    const av = slopeValue(a.slopes?.[name]);
    const bv = slopeValue(b.slopes?.[name]);
    const available = Number.isFinite(av) && Number.isFinite(bv);
    const meanMagnitude = available ? (Math.abs(av) + Math.abs(bv)) / 2 : null;
    const cv = available && meanMagnitude ? Math.abs(Math.abs(av) - Math.abs(bv)) / (Math.SQRT2 * meanMagnitude) : available ? 0 : null;
    slopes[name] = { available, signAgrees: available && sign(av) === sign(bv), coefficientOfVariation: cv,
      flaggedOver25Percent: cv !== null && cv > 0.25, pass: available && sign(av) === sign(bv) };
  }
  const scenariosComplete = [a, b].every(run => Object.values(run.scenarios ?? {}).every(value => value === 'complete'));
  return {
    pass: scenariosComplete && Object.keys(categories).length > 0 && Object.values(categories).every(value => value.pass)
      && Object.keys(slopes).length > 0 && Object.values(slopes).every(value => value.pass),
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
];
export function assertRedacted(text) {
  for (const pattern of FORBIDDEN) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) throw new Error(`Unsafe resource report content matched ${pattern}: ${match[0].slice(0, 60)}`);
  }
}
export function sanitizeOwner(value) {
  return String(value).replace(/(?:file:\/\/)?\/(?:home|Users|tmp|private|var)\/[\w./@~-]+/g, '<path>')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').slice(0, 160);
}
export function manifestHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

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
    'JavaScript heap, V8 external memory, native allocator totals and logical decoded-image bytes can overlap and are never presented as disjoint buckets.', '',
    `Result: **${report.pass ? 'pass' : 'incomplete'}**`, '', '## Scenarios', '',
    ...Object.entries(report.scenarios ?? {}).map(([name, value]) => `- ${name}: ${value}`), '',
  ];
  for (const phase of report.phases ?? []) lines.push(`- ${phase.name}: PSS ${phase.totalPssBytes ?? 'unavailable'}; private resident ${phase.totalPrivateResidentBytes ?? 'unavailable'}; JS heap ${phase.renderer?.jsHeapUsedBytes ?? 'unavailable'}`);
  lines.push('', '## Retained owner rankings', '');
  for (const [category, rows] of Object.entries(report.rankings ?? {})) {
    lines.push(`### ${category}`, ...mergedRanks(rows).slice(0, 10).map((row, index) => `${index + 1}. \`${row.owner}\` — ${row.bytes} bytes`), '');
  }
  lines.push('## Slopes', '', ...Object.entries(report.slopes ?? {}).map(([name, value]) => `- ${name}: ${typeof value === 'number' ? value : value?.value ?? 'unavailable'}`), '',
    '## Capabilities and limitations', '', ...Object.entries(report.capabilities ?? {}).map(([name, value]) => `- ${name}: ${value}`),
    ...(report.unsupported ?? []).map(value => `- unavailable: ${value}`), '',
    'Raw heap snapshots, memory traces, inspector registrations, URLs, scratch paths, session identifiers, commands and payloads are deliberately omitted.', '');
  return `${lines.join('\n')}\n`;
}

export async function scanArtifacts(files) {
  for (const file of files) assertRedacted(await readFile(file, 'utf8'));
}
