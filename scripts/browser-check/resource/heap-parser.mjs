/**
 * Bounded heap-snapshot reader. Runs alone in its own process, under an
 * enforced `--max-old-space-size`, over one raw snapshot at a time.
 *
 * It never parses the whole file as JSON. The header object is small and is
 * read as JSON; the `nodes` and `edges` arrays are streamed straight into typed
 * arrays sized from the header's own counts, and `strings` is streamed a second
 * time to fetch only the handful of names the result actually prints.
 *
 * Two bounds matter and both are declared here. `--max-old-space-size` bounds
 * the JavaScript heap, but typed arrays are external to it, so the real bound
 * of this process is `EXTERNAL_BUDGET_BYTES`: the graph's own arrays are
 * costed from the header *before* anything is allocated, and a snapshot whose
 * shape would exceed that budget is refused rather than attempted.
 *
 * Limitation: retained size here is "reachable from this object and from
 * nothing else", computed by exclusion. DevTools computes retained size from a
 * dominator tree and gives weak edges their own treatment; this reader does not
 * distinguish weak or internal edge types, so a value here can differ from the
 * number DevTools would print for the same object. It is used for comparison
 * between runs of the same shape, not as a DevTools equivalent.
 */
import { open } from 'node:fs/promises';
import { SAFETY } from './config.mjs';

// Only the child process invoked as the parser reads argv; importing this
// module for its declared bounds and validation must never start a parse.
const invoked = typeof process.argv[1] === 'string' && process.argv[1].endsWith('heap-parser.mjs');
const file = invoked ? process.argv[2] : null;
const targets = invoked ? JSON.parse(process.argv[3] ?? '{}') : {};
const CHUNK = 4 * 1024 * 1024;
const HEADER_BYTES = 4 * 1024 * 1024;
/** Typed-array (external) budget for one snapshot's graph, outside the JS heap. */
export const EXTERNAL_BUDGET_BYTES = 512 * 1024 * 1024;
/** Per-node and per-edge cost of the arrays this reader allocates. */
export const NODE_ARRAY_BYTES = 24;
export const EDGE_ARRAY_BYTES = 4;
const MAX_ENTRIES = 1e9;

export function graphBudget(nodeCount, edgeCount, budget = EXTERNAL_BUDGET_BYTES) {
  const bytes = nodeCount * NODE_ARRAY_BYTES + edgeCount * EDGE_ARRAY_BYTES;
  return { bytes, budget, fits: bytes <= budget };
}

function unavailable(reason) { process.stdout.write(JSON.stringify({ available: false, reason })); }

class ByteReader {
  constructor(handle) { this.handle = handle; this.buf = Buffer.allocUnsafe(CHUNK); this.len = 0; this.pos = 0; this.eof = false; }
  async more() {
    if (this.pos < this.len) return true;
    if (this.eof) return false;
    const { bytesRead } = await this.handle.read(this.buf, 0, CHUNK);
    if (!bytesRead) { this.eof = true; return false; }
    this.len = bytesRead; this.pos = 0;
    return true;
  }
  /** Advance just past the next occurrence of an ASCII literal. */
  async seek(literal) {
    const needle = Buffer.from(literal);
    let matched = 0;
    while (await this.more()) {
      const buf = this.buf, len = this.len;
      for (let i = this.pos; i < len; i++) {
        const byte = buf[i];
        matched = byte === needle[matched] ? matched + 1 : byte === needle[0] ? 1 : 0;
        if (matched === needle.length) { this.pos = i + 1; return true; }
      }
      this.pos = len;
    }
    return false;
  }
  /** Stream one JSON array of integers, stopping just past its closing bracket. */
  async readIntegers(sink) {
    let value = 0, digits = false, negative = false, index = 0;
    while (await this.more()) {
      const buf = this.buf, len = this.len;
      for (let i = this.pos; i < len; i++) {
        const byte = buf[i];
        if (byte >= 48 && byte <= 57) { value = value * 10 + (byte - 48); digits = true; continue; }
        if (byte === 45) { negative = true; continue; }
        if (digits) { sink(index++, negative ? -value : value); value = 0; digits = false; negative = false; }
        if (byte === 93) { this.pos = i + 1; return index; }
      }
      this.pos = len;
    }
    throw new Error('the snapshot ended inside a numeric array');
  }
  /** Stream the strings array, keeping only the indices the result needs. */
  async readStrings(needed) {
    const found = new Map();
    if (needed.size === 0) return found;
    let index = 0, inString = false, escaped = false, capturing = false;
    let captured = [];
    while (await this.more()) {
      const buf = this.buf, len = this.len;
      for (let i = this.pos; i < len; i++) {
        const byte = buf[i];
        if (inString) {
          if (escaped) { escaped = false; if (capturing) captured.push(byte); continue; }
          if (byte === 92) { escaped = true; if (capturing) captured.push(byte); continue; }
          if (byte === 34) {
            inString = false;
            if (capturing) {
              found.set(index, Buffer.from(captured).toString('utf8'));
              captured = []; capturing = false;
              if (found.size === needed.size) { this.pos = i + 1; return found; }
            }
            index += 1;
            continue;
          }
          if (capturing) captured.push(byte);
          continue;
        }
        if (byte === 34) { inString = true; capturing = needed.has(index); continue; }
        if (byte === 93) { this.pos = i + 1; return found; }
      }
      this.pos = len;
    }
    return found;
  }
}

function headerObject(text) {
  const start = text.indexOf('"snapshot":');
  if (start < 0) throw new Error('the snapshot header is missing');
  const open = text.indexOf('{', start);
  let depth = 0, inString = false, escaped = false;
  for (let i = open; i < text.length; i++) {
    const character = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(text.slice(open, i + 1));
  }
  throw new Error('the snapshot header did not close inside the first chunk');
}

/** Everything the graph pass depends on, refused loudly when it is not there. */
export function validateHeader(header) {
  const meta = header?.meta;
  if (!meta || typeof meta !== 'object') throw new Error('the snapshot header carries no meta');
  for (const key of ['node_fields', 'edge_fields', 'node_types']) {
    if (!Array.isArray(meta[key]) || meta[key].length === 0) throw new Error(`the snapshot meta has no ${key}`);
  }
  if (!Array.isArray(meta.node_types[0]) || meta.node_types[0].length === 0) throw new Error('the snapshot meta has no node type names');
  const fields = { type: 'node_fields', name: 'node_fields', id: 'node_fields', self_size: 'node_fields', edge_count: 'node_fields' };
  const index = {};
  for (const [field, source] of Object.entries(fields)) {
    index[field] = meta[source].indexOf(field);
    if (index[field] < 0) throw new Error(`the snapshot meta has no ${field} node field`);
  }
  index.to_node = meta.edge_fields.indexOf('to_node');
  if (index.to_node < 0) throw new Error('the snapshot meta has no to_node edge field');
  const { node_count: nodeCount, edge_count: edgeCount } = header;
  for (const [label, value] of [['node_count', nodeCount], ['edge_count', edgeCount]]) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_ENTRIES) throw new Error(`the snapshot header declares an unusable ${label}`);
  }
  return { meta, index, nodeCount, edgeCount, nodeWidth: meta.node_fields.length, edgeWidth: meta.edge_fields.length };
}

function cleanNodeName(type, value) {
  if (type === 'string' || type === 'concatenated string' || type === 'sliced string') return '<string>';
  const name = String(value ?? '');
  return /^[A-Za-z_$][\w$ .<>-]{0,79}$/.test(name) ? name : '<anonymous>';
}

if (file) {
  try {
    const handle = await open(file, 'r');
    let result;
    try {
      const size = (await handle.stat()).size;
      if (size > SAFETY.snapshotBytes) {
        unavailable(`snapshot ${size} bytes exceeds the bounded capture ceiling ${SAFETY.snapshotBytes}`);
        process.exit(0);
      }
      const head = Buffer.allocUnsafe(Math.min(HEADER_BYTES, Math.max(1, size)));
      await handle.read(head, 0, head.length, 0);
      const { meta, index, nodeCount, edgeCount, nodeWidth, edgeWidth } = validateHeader(headerObject(head.toString('utf8')));
      const budget = graphBudget(nodeCount, edgeCount);
      if (!budget.fits) {
        unavailable(`snapshot graph would need ${budget.bytes} bytes of typed arrays, over the declared ${budget.budget}-byte reader budget`);
        process.exit(0);
      }

      const nodeTypes = new Uint8Array(nodeCount);
      const nodeNames = new Uint32Array(nodeCount);
      const shallow = new Float64Array(nodeCount);
      const offsets = new Uint32Array(nodeCount + 1);
      const wanted = new Set(Object.values(targets));
      const found = new Map();
      const typeNames = meta.node_types[0];

      const reader = new ByteReader(handle);
      if (!await reader.seek('"nodes":[')) throw new Error('the snapshot has no nodes array');
      let malformed = null;
      const nodeValues = await reader.readIntegers((position, value) => {
        const field = position % nodeWidth;
        const node = (position - field) / nodeWidth;
        if (node >= nodeCount) { malformed ??= 'the nodes array holds more nodes than the header declares'; return; }
        if (field === index.self_size) { if (value < 0) malformed ??= 'a node declares a negative self size'; shallow[node] = value; }
        else if (field === index.edge_count) { if (value < 0) malformed ??= 'a node declares a negative edge count'; offsets[node] = value; }
        else if (field === index.name) nodeNames[node] = value;
        else if (field === index.type) { if (value < 0 || value >= typeNames.length) malformed ??= 'a node declares an unknown type'; nodeTypes[node] = value; }
        else if (field === index.id && wanted.has(value)) found.set(value, node);
      });
      if (malformed) throw new Error(malformed);
      if (nodeValues !== nodeCount * nodeWidth) throw new Error(`the nodes array holds ${nodeValues} values, not ${nodeCount * nodeWidth}`);

      let totalEdges = 0;
      for (let node = 0; node < nodeCount; node++) { const count = offsets[node]; offsets[node] = totalEdges; totalEdges += count; }
      offsets[nodeCount] = totalEdges;
      if (totalEdges !== edgeCount) throw new Error(`node edge counts sum to ${totalEdges}, not ${edgeCount}`);

      if (!await reader.seek('"edges":[')) throw new Error('the snapshot has no edges array');
      const to = new Uint32Array(edgeCount);
      const edgeValues = await reader.readIntegers((position, value) => {
        const field = position % edgeWidth;
        if (field !== index.to_node) return;
        const edge = (position - field) / edgeWidth;
        if (edge >= edgeCount) { malformed ??= 'the edges array holds more edges than the header declares'; return; }
        if (value < 0 || value % nodeWidth !== 0 || value / nodeWidth >= nodeCount) { malformed ??= 'an edge points outside the nodes array'; return; }
        to[edge] = value / nodeWidth;
      });
      if (malformed) throw new Error(malformed);
      if (edgeValues !== edgeCount * edgeWidth) throw new Error(`the edges array holds ${edgeValues} values, not ${edgeCount * edgeWidth}`);

      // One reusable traversal stack and one reusable mark array: a walk over a
      // full-scale graph must not allocate per node.
      const stack = new Uint32Array(nodeCount + 1);
      const seen = new Uint8Array(nodeCount);
      const reachableWithout = excluded => {
        seen.fill(0); seen[0] = 1;
        let top = 0; stack[top++] = 0;
        while (top) {
          const n = stack[--top];
          for (let e = offsets[n]; e < offsets[n + 1]; e++) {
            const next = to[e];
            if (next === excluded || seen[next]) continue;
            seen[next] = 1; stack[top++] = next;
          }
        }
        return seen;
      };

      const results = {};
      const neededNames = new Set();
      for (const [label, rawId] of Object.entries(targets)) {
        const target = found.get(rawId);
        if (target === undefined) { results[label] = { available: false, reason: 'heap object id absent' }; continue; }
        const outside = reachableWithout(target).slice();
        const owned = new Uint8Array(nodeCount);
        let cursor = 0; stack[cursor++] = target; owned[target] = 1;
        let retainedBytes = 0;
        // Only the twenty largest owned nodes are ever reported, so only twenty
        // are ever held.
        const largest = [];
        let smallest = -Infinity;
        while (cursor) {
          const n = stack[--cursor];
          if (!outside[n]) {
            const bytes = shallow[n];
            retainedBytes += bytes;
            if (bytes > 0 && (largest.length < 20 || bytes > smallest)) {
              largest.push({ bytes, typeIndex: nodeTypes[n], nameIndex: nodeNames[n] });
              if (largest.length >= 20) {
                largest.sort((a, b) => b.bytes - a.bytes);
                largest.length = 20;
                smallest = largest[19].bytes;
              }
            }
          }
          for (let e = offsets[n]; e < offsets[n + 1]; e++) {
            const next = to[e]; if (!owned[next]) { owned[next] = 1; stack[cursor++] = next; }
          }
        }
        largest.sort((a, b) => b.bytes - a.bytes);
        const top = largest.slice(0, 20);
        for (const row of top) neededNames.add(row.nameIndex);
        results[label] = { available: true, shallowBytes: shallow[target], retainedBytes, largestOwnedNodes: top };
      }

      // Names are wanted for at most twenty nodes per target, and the strings
      // section is the last one, so it is read on a second pass from the start
      // rather than held in memory during the graph work.
      let names = new Map();
      if (neededNames.size) {
        const again = await open(file, 'r');
        try {
          const scan = new ByteReader(again);
          if (await scan.seek('"strings":[')) names = await scan.readStrings(neededNames);
        } finally { await again.close(); }
      }
      for (const value of Object.values(results)) {
        if (!value.available) continue;
        value.largestOwnedNodes = value.largestOwnedNodes.map(row => {
          const type = typeNames[row.typeIndex];
          return { bytes: row.bytes, type, name: cleanNodeName(type, names.get(row.nameIndex)) };
        });
      }
      result = { available: true, nodeCount, edgeCount, targets: results,
        bound: { typedArrayBytes: budget.bytes, budgetBytes: budget.budget, jsHeapLimitMb: SAFETY.parserHeapMb },
        limitation: 'retained size is computed by exclusion and does not model weak edges the way DevTools dominator trees do' };
    } finally {
      await handle.close();
    }
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    unavailable(error instanceof Error ? error.message : String(error));
  }
}
