import { readFile, stat } from 'node:fs/promises';

const file = process.argv[2];
const targets = JSON.parse(process.argv[3] ?? '{}');
const JSON_PARSE_LIMIT = 96 * 1024 * 1024;

function unavailable(reason) { process.stdout.write(JSON.stringify({ available: false, reason })); }

try {
  const size = (await stat(file)).size;
  if (size > JSON_PARSE_LIMIT) {
    unavailable(`snapshot ${size} bytes exceeds bounded parser JSON limit ${JSON_PARSE_LIMIT}`);
    process.exit(0);
  }
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  const meta = snapshot.snapshot.meta;
  const nf = meta.node_fields;
  const ef = meta.edge_fields;
  const nodeWidth = nf.length;
  const edgeWidth = ef.length;
  const nodeCount = snapshot.nodes.length / nodeWidth;
  const nodeType = nf.indexOf('type');
  const nodeName = nf.indexOf('name');
  const nodeId = nf.indexOf('id');
  const nodeSelf = nf.indexOf('self_size');
  const nodeEdges = nf.indexOf('edge_count');
  const edgeType = ef.indexOf('type');
  const edgeName = ef.indexOf('name_or_index');
  const edgeTo = ef.indexOf('to_node');
  const offsets = new Uint32Array(nodeCount + 1);
  const shallow = new Float64Array(nodeCount);
  const ids = new Map();
  let totalEdges = 0;
  for (let i = 0; i < nodeCount; i++) {
    const off = i * nodeWidth;
    offsets[i] = totalEdges;
    totalEdges += snapshot.nodes[off + nodeEdges];
    shallow[i] = snapshot.nodes[off + nodeSelf];
    const id = snapshot.nodes[off + nodeId];
    if (Object.values(targets).includes(id)) ids.set(id, i);
  }
  offsets[nodeCount] = totalEdges;
  const to = new Uint32Array(totalEdges);
  const edgeNames = new Uint32Array(totalEdges);
  const edgeTypes = new Uint8Array(totalEdges);
  for (let e = 0; e < totalEdges; e++) {
    const off = e * edgeWidth;
    to[e] = snapshot.edges[off + edgeTo] / nodeWidth;
    edgeNames[e] = snapshot.edges[off + edgeName];
    edgeTypes[e] = snapshot.edges[off + edgeType];
  }
  const reachableWithout = excluded => {
    const seen = new Uint8Array(nodeCount); const stack = [0]; seen[0] = 1;
    while (stack.length) {
      const n = stack.pop();
      for (let e = offsets[n]; e < offsets[n + 1]; e++) {
        const next = to[e];
        if (next === excluded || seen[next]) continue;
        seen[next] = 1; stack.push(next);
      }
    }
    return seen;
  };
  const cleanNodeName = (type, value) => {
    if (type === 'string' || type === 'concatenated string' || type === 'sliced string') return '<string>';
    const name = String(value ?? '');
    return /^[A-Za-z_$][\w$ .<>-]{0,79}$/.test(name) ? name : '<anonymous>';
  };
  const results = {};
  for (const [label, rawId] of Object.entries(targets)) {
    const target = ids.get(rawId);
    if (target === undefined) { results[label] = { available: false, reason: 'heap object id absent' }; continue; }
    const outside = reachableWithout(target);
    const owned = new Uint8Array(nodeCount); const queue = [target]; owned[target] = 1;
    let retainedBytes = 0; const largest = [];
    while (queue.length) {
      const n = queue.pop();
      if (!outside[n]) {
        retainedBytes += shallow[n];
        const off = n * nodeWidth;
        if (shallow[n] > 0) {
          const type = meta.node_types[0][snapshot.nodes[off + nodeType]];
          largest.push({ bytes: shallow[n], type, name: cleanNodeName(type, snapshot.strings[snapshot.nodes[off + nodeName]]) });
        }
      }
      for (let e = offsets[n]; e < offsets[n + 1]; e++) {
        const next = to[e]; if (!owned[next]) { owned[next] = 1; queue.push(next); }
      }
    }
    largest.sort((a,b) => b.bytes - a.bytes);
    results[label] = { available: true, shallowBytes: shallow[target], retainedBytes, largestOwnedNodes: largest.slice(0, 20) };
  }
  process.stdout.write(JSON.stringify({ available: true, nodeCount, edgeCount: totalEdges, targets: results }));
} catch (error) {
  unavailable(error instanceof Error ? error.message : String(error));
}
