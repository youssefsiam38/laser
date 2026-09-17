import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export async function linuxStartToken(pid) {
  const [stat, boot] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return `linux:${boot.trim()}:${fields[19]}`;
}

export async function descendantPids(rootPid) {
  const result = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    let text;
    try { text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'); } catch { continue; }
    for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
      const child = Number(raw);
      if (!result.has(child)) { result.add(child); queue.push(child); }
    }
  }
  return result;
}

export class InspectorClient {
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', event => this.#message(JSON.parse(String(event.data))));
    socket.addEventListener('close', () => this.#fail(new Error(`${label} inspector closed.`)));
    socket.addEventListener('error', () => this.#fail(new Error(`${label} inspector failed.`)));
  }
  #message(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(`${pending.method}: ${message.error.message}`)) : pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }
  #fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  on(method, listener) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener); this.listeners.set(method, set);
    return () => set.delete(listener);
  }
  async send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const promise = new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject, method }));
    this.socket.send(JSON.stringify({ id, method, params }));
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms.`)), timeoutMs); });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async close(timeoutMs = 5_000) {
    if (this.socket.readyState === 3) return;
    const closed = new Promise(resolveClose => this.socket.addEventListener('close', resolveClose, { once: true }));
    this.socket.close();
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${this.label} inspector close timed out.`)), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}

export async function connectInspector(record, { rootPid, label = `pid-${record.pid}` } = {}) {
  if (!Number.isInteger(record.pid) || typeof record.startToken !== 'string' || !/^ws:\/\/127\.0\.0\.1:/.test(record.url ?? '')) {
    throw new Error(`Invalid ${label} inspector registration.`);
  }
  if (await linuxStartToken(record.pid) !== record.startToken) throw new Error(`Stale ${label} inspector registration.`);
  if (rootPid !== undefined && !(await descendantPids(rootPid)).has(record.pid)) throw new Error(`${label} is outside the owned process tree.`);
  const socket = new WebSocket(record.url);
  await Promise.race([
    new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true });
      socket.addEventListener('error', () => reject(new Error(`Could not connect ${label} inspector.`)), { once: true });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} inspector connect timed out.`)), 10_000)),
  ]);
  const client = new InspectorClient(socket, label);
  await client.send('Runtime.enable');
  await client.send('HeapProfiler.enable');
  return client;
}

export async function waitForRegistrations(directory, { rootPid, minimum = 1, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await readdir(directory).catch(() => []);
    const records = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      try {
        const record = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
        if (!rootPid || (await descendantPids(rootPid)).has(record.pid)) records.push({ ...record, file: resolve(directory, file) });
      } catch {}
    }
    if (records.length >= minimum) return records.sort((a, b) => a.pid - b.pid);
    await delay(100);
  }
  throw new Error(`Only ${minimum - 1} or fewer owned inspector registrations appeared.`);
}

export async function queryInstances(client, moduleUrl, exportName, { exact = 1, minimum = exact === null ? 0 : exact } = {}) {
  const group = `resource-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expression = `globalThis.__resourceSoakPrototypes?.[${JSON.stringify(exportName)}] ?? (async()=> (await import(${JSON.stringify(moduleUrl)}))[${JSON.stringify(exportName)}].prototype)()`;
  const evaluated = await client.send('Runtime.evaluate', { expression, awaitPromise: true, objectGroup: group });
  if (!evaluated.result?.objectId) throw new Error(`${exportName} prototype was not reachable.`);
  const queried = await client.send('Runtime.queryObjects', { prototypeObjectId: evaluated.result.objectId, objectGroup: group });
  if (!queried.objects?.objectId) throw new Error(`${exportName} instances were not queryable.`);
  const count = await callFunction(client, queried.objects.objectId, 'function(){ return Array.from(this).length; }', { returnByValue: true });
  if ((exact !== null && count !== exact) || count < minimum) {
    await client.send('Runtime.releaseObjectGroup', { objectGroup: group });
    throw new Error(exact === null ? `Expected at least ${minimum} live ${exportName}; found ${count}.` : `Expected exactly ${exact} live ${exportName}; found ${count}.`);
  }
  const first = count ? await callFunction(client, queried.objects.objectId, 'function(){ return Array.from(this)[0]; }') : undefined;
  return { group, count, objectsId: queried.objects.objectId, instanceId: first?.objectId };
}

export async function callFunction(client, objectId, functionDeclaration, options = {}) {
  const response = await client.send('Runtime.callFunctionOn', {
    objectId, functionDeclaration, awaitPromise: true,
    returnByValue: options.returnByValue ?? false,
    // Scalars, or a remote object this harness already captured: never a path,
    // an identity or anything read out of a conversation.
    ...(options.args
      ? { arguments: options.args.map(value => (value && typeof value === 'object' && typeof value.objectId === 'string' ? value : { value })) }
      : {}),
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Inspector evaluation failed.');
  return options.returnByValue ? response.result?.value : response.result;
}

/**
 * The host's scalar projection. Counts, bytes and statuses; never a path, a
 * payload or a socket address.
 *
 * Transcript delivery and attachment are one thing since RP-6 (M18-T6): a
 * connection is following a conversation because it holds it, and the
 * per-connection `TranscriptDelivery` is where that is written down. The maps
 * this used to read — `HostServer.attached`, and `TranscriptDelivery.loaded` /
 * `.loading` — no longer exist, so every attachment and delivery row was a
 * zero while clients held transcripts, and the retirement guard that reads
 * them was proving nothing.
 *
 * It now reads only the canonical public membership view — `counts()`,
 * `paths()` and `admittedHolders(path)` — never the private table behind it,
 * and returns counts alone: the path set is built and measured inside the host
 * and never leaves it. A delivery record that cannot answer all three makes
 * every membership number `null`, with the reason beside it: unreadable
 * evidence is not an empty host.
 */
export const HOST_COUNTERS_FN = `function(){
    const s=this; const sockets=Array.from(s.clients ?? []);
    const table=s.transcripts;
    const deliveries=table && typeof table.values==='function' ? Array.from(table.values()) : null;
    const complete=deliveries !== null && deliveries.every(d=>d && typeof d.counts==='function' && typeof d.paths==='function' && typeof d.admittedHolders==='function');
    let membership;
    if(!complete){
      membership={ available:false,
        reason:deliveries===null ? 'the host keeps no per-connection transcript delivery table' : 'a transcript delivery record does not publish the membership view',
        connections:deliveries===null ? null : deliveries.length, paths:null, owners:null, admittedOwners:null, loadingOwners:null };
    } else {
      // Bounded by the product's own membership caps (256 paths × 8 owners per
      // connection). Only the size of this set is returned.
      const distinct=new Set(); let owners=0; let admitted=0; let failed=null;
      try {
        for(const delivery of deliveries){
          owners+=delivery.counts().owners;
          for(const path of delivery.paths()){ distinct.add(path); admitted+=delivery.admittedHolders(path); }
        }
      } catch(error) { failed='the membership view could not be read'; }
      membership=failed
        ? { available:false, reason:failed, connections:deliveries.length, paths:null, owners:null, admittedOwners:null, loadingOwners:null }
        : { available:true, reason:null, connections:deliveries.length, paths:distinct.size, owners,
            admittedOwners:admitted, loadingOwners:Math.max(0, owners-admitted) };
    }
    const workers=Array.from(s.pool?.entries?.values?.() ?? []);
    const tasks=s.tasks?.list?.() ?? [];
    const runs=s.runs?.list?.() ?? []; const terminalRuns=new Set(['completed','blocked','failed','cancelled']);
    const attentionRows=Array.from(s.attention?.live?.values?.() ?? []);
    return { kind:'host', connections:sockets.length, bufferedBytes:sockets.reduce((n,w)=>n+(w.bufferedAmount||0),0),
      queuedSockets:sockets.filter(w=>(w.bufferedAmount||0)>0).length,
      // An attachment is a membership hold: surfaces holding conversations, and
      // the conversations they hold.
      attachmentRefs:membership.owners, attachedPaths:membership.paths,
      runningSessions:workers.reduce((n,w)=>n+(w.running?.size||0),0), liveRuns:runs.filter(run=>!terminalRuns.has(run.status)).length,
      attentionDialogs:attentionRows.reduce((n,row)=>n+(row.dialogs?.size||0),0),
      // Owners admitted to delivery, and owners whose load is still in flight.
      transcriptLoaded:membership.admittedOwners, transcriptLoading:membership.loadingOwners,
      transcriptPaths:membership.paths, transcriptDelivery:membership,
      loadDeliveries:Array.from(s.loadDeliveries?.values?.() ?? []).reduce((n,set)=>n+set.size,0),
      pendingLogRows:s.pendingLogRows?.length||0, tasks:tasks.length, runningTasks:tasks.filter(t=>t.status==='running').length,
      taskStatuses:tasks.reduce((o,t)=>(o[t.status]=(o[t.status]||0)+1,o),{}), workers:workers.length,
      logs:s.logs?.stats?.() ?? null, memory:process.memoryUsage() };
  }`;

/**
 * The worker's scalar projection, read from the table RP-4 (M18-T4) made
 * canonical: `WorkerServer.runtimes` is a `SessionRuntimes<Live>`, and the
 * `sessions` map this used to read no longer exists. Reading the old name
 * reported every retained row as zero while workers held sessions, which is
 * the one thing a retention projection may never do.
 *
 * Three rules hold here:
 *
 * - **No mutation.** Every read is a getter, a `Map` iteration or the engine's
 *   own synchronous entry accessor. Nothing is opened, closed or collected.
 * - **No identity, no content.** Only counts and bytes leave the process: not
 *   a path, not an entry, not a title.
 * - **Absent evidence is `null`, never `0`.** A worker whose table cannot be
 *   read is `available: false`; a live row whose entry count cannot be read
 *   makes the aggregate `null` and is counted in `entriesUnreadable`, with the
 *   readable part kept separately as `entriesKnown`.
 */
export const WORKER_COUNTERS_FN = `function(){
    const server=this; const memory=process.memoryUsage();
    const unavailable=(reason)=>({ kind:'worker', available:false, reason, sessions:null, opening:null, releasing:null,
      retiring:null, fenced:null, entries:null, entriesKnown:null, entriesReadable:0, entriesUnreadable:0,
      entriesSource:'engine session manager', replayCount:null, replayBytes:null, replayReadable:0, replayUnreadable:0,
      tasks:null, runningTasks:null, pendingQuestions:null, pendingApprovals:null, memory });
    const table=server.runtimes;
    if(!table || typeof table.values!=='function' || typeof table.size!=='number') return unavailable('worker session runtime table unavailable');
    let live; try { live=Array.from(table.values()); } catch(error) { return unavailable('worker session runtimes unreadable'); }
    const rows=[]; const pending=[];
    for(const item of live){
      const driver=item && item.driver;
      let entries=null;
      try {
        const runtime=driver && driver.runtime;
        const manager=runtime && runtime.session ? runtime.session.sessionManager : undefined;
        const list=manager && typeof manager.getEntries==='function' ? manager.getEntries() : undefined;
        if(Array.isArray(list)) entries=list.length;
      } catch(error) { entries=null; }
      try { if(driver && typeof driver.pendingUi==='function') pending.push(...driver.pendingUi()); } catch(error) {}
      const buffer=item && item.buffer;
      const replayCount=buffer && typeof buffer.size==='number' ? buffer.size : null;
      const replayBytes=buffer && typeof buffer.bytes==='number' ? buffer.bytes : null;
      rows.push({ entries, replayCount, replayBytes });
    }
    // A sum is honest only when every row answered: one unreadable row makes the
    // total unavailable, and what was readable is reported beside it.
    const fold=(key)=>{ let total=0, readable=0, unreadable=0;
      for(const row of rows){ const value=row[key];
        if(typeof value==='number' && Number.isFinite(value)) { total+=value; readable+=1; } else unreadable+=1; }
      return { total, readable, unreadable, value: unreadable===0 ? total : null }; };
    const entryFold=fold('entries'); const replayCountFold=fold('replayCount'); const replayBytesFold=fold('replayBytes');
    const taskRows=[]; const bySession=server.tasks && server.tasks.bySession;
    for(const value of (bySession && typeof bySession.values==='function' ? bySession.values() : [])) {
      for(const task of (value && typeof value.values==='function' ? value.values() : value)) taskRows.push(task);
    }
    return { kind:'worker', available:true,
      sessions:table.size,
      opening:typeof table.openPaths==='function' ? table.openPaths().length : null,
      releasing:typeof table.releasingPaths==='function' ? table.releasingPaths().length : null,
      retiring:typeof table.retiring==='boolean' ? table.retiring : null,
      fenced:typeof table.fenced==='boolean' ? table.fenced : null,
      entries:entryFold.value, entriesKnown:entryFold.total, entriesReadable:entryFold.readable,
      entriesUnreadable:entryFold.unreadable, entriesSource:'engine session manager',
      replayCount:replayCountFold.value, replayBytes:replayBytesFold.value,
      replayReadable:replayCountFold.readable, replayUnreadable:replayCountFold.unreadable,
      tasks:taskRows.length, runningTasks:taskRows.filter(task=>task && task.status==='running').length,
      pendingQuestions:pending.filter(request=>!request.toolCallId).length,
      pendingApprovals:pending.filter(request=>Boolean(request.toolCallId)).length, memory };
  }`;

/**
 * Find the one direct connection that opened from this loopback port, and
 * hand the **object itself** back.
 *
 * A port is how the harness's own socket is *admitted* once: it is not an
 * identity. The kernel can hand the same ephemeral port to another socket, and
 * a byte counter that did not go backwards proves nothing about which socket
 * produced it. So this runs exactly once, refuses anything but a unique match,
 * and returns the live `WebSocket`; every later reading is taken through that
 * object. The object id stays inside the harness and never reaches a report.
 */
export const CONNECTION_TARGET_FN = `function(port){
    const server=this; const clients=Array.from(server.clients ?? []);
    const matches=clients.filter(ws=>ws && ws._socket && ws._socket.remotePort===port);
    if(matches.length===0) throw new Error('No host connection was open from that loopback port.');
    if(matches.length>1) throw new Error('More than one host connection was open from that loopback port.');
    return matches[0];
  }`;

/**
 * One captured connection's pressure account (RP-7), and nothing else.
 *
 * The connection is the object the caller captured, not whatever is on a port
 * now: `present` is the host's own `clients.has(target)`, checked independently
 * of the queue account, so a connection the host dropped is reported as gone
 * rather than as an empty queue. Counts, bytes and the state machine's word for
 * what it did — never an address, a port, a path or a payload.
 */
export const CONNECTION_PRESSURE_FN = `function(target){
    const server=this; const clients=Array.from(server.clients ?? []);
    if(!target || typeof target!=='object') return { readable:false, reason:'the captured connection object was not passed back', present:null, connection:null, connections:clients.length, totalBufferedBytes:null };
    const registry=server.clients;
    const present=registry && typeof registry.has==='function' ? registry.has(target)===true : null;
    const pressure=server.pressure && typeof server.pressure.get==='function' ? server.pressure.get(target) : undefined;
    const snapshot=pressure && typeof pressure.snapshot==='function' ? pressure.snapshot() : null;
    const socketBufferedBytes=Number(target.bufferedAmount)||0;
    const accountedBytes=snapshot && Number.isFinite(snapshot.queuedBytes) ? snapshot.queuedBytes : null;
    return { readable:present!==null,
      reason:present===null ? 'the host does not keep a client registry this harness can check membership in' : null,
      present,
      connection:{ readyState:target.readyState,
        pendingBytes:Math.max(socketBufferedBytes, accountedBytes||0, (snapshot && Number(snapshot.socketBufferedBytes))||0),
        socketBufferedBytes, accountedBytes,
        highWaterBytes:snapshot ? snapshot.highWaterBytes : null,
        state:snapshot ? snapshot.state : null,
        fenced:pressure ? pressure.fenced===true : null,
        inFlight:snapshot ? snapshot.inFlight : null,
        shed:snapshot && snapshot.shed ? snapshot.shed.total : null,
        tracked:pressure !== undefined },
      connections:clients.length,
      totalBufferedBytes:clients.reduce((n,ws)=>n+((Number(ws.bufferedAmount)||0)),0) };
  }`;

export async function scalarCounters(client, instanceId, kind) {
  return callFunction(client, instanceId, kind === 'host' ? HOST_COUNTERS_FN : WORKER_COUNTERS_FN, { returnByValue: true });
}

/**
 * Capture the exact host-side socket a loopback port belongs to, once.
 *
 * Returns a reader bound to that object and a release for its object group.
 * Nothing about the handle — not the id, not the group — is ever reported.
 */
export async function captureConnectionTarget(client, instanceId, remotePort) {
  if (!Number.isInteger(remotePort)) throw new Error('A connection can only be admitted by its own integer loopback port.');
  const group = `connection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await client.send('Runtime.callFunctionOn', {
    objectId: instanceId, functionDeclaration: CONNECTION_TARGET_FN,
    arguments: [{ value: remotePort }], objectGroup: group, awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description?.split('\n')[0] ?? response.exceptionDetails.text ?? 'The host connection could not be captured.');
  const objectId = response.result?.objectId;
  if (!objectId) throw new Error('The host connection was not returned as an object this harness can hold.');
  return {
    group,
    read: () => connectionPressure(client, instanceId, objectId),
    release: () => client.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}),
  };
}

/** One bounded read of one captured connection's queue state on the host. */
export async function connectionPressure(client, instanceId, targetObjectId) {
  if (typeof targetObjectId !== 'string' || targetObjectId === '') throw new Error('A connection reading needs the captured connection object.');
  return callFunction(client, instanceId, CONNECTION_PRESSURE_FN, { returnByValue: true, args: [{ objectId: targetObjectId }] });
}

/**
 * TailBuffer has no single published handle, so counting it costs one
 * heap-walking query. A worker that never ran a command holds none of them, and
 * that is a zero, not an unreadable process: `minimum` says which of the two a
 * caller is asking for.
 */
export async function tailBufferCounters(client, moduleUrl, { minimum = 0 } = {}) {
  const found = await queryInstances(client, moduleUrl, 'TailBuffer', { exact: null, minimum });
  try {
    return await callFunction(client, found.objectsId, `function(){ const a=Array.from(this); const sizes=a.map(x=>x.size||0); return {count:a.length,bytes:sizes.reduce((n,x)=>n+x,0),maxBytes:Math.max(0,...sizes)}; }`, { returnByValue: true });
  } finally { await client.send('Runtime.releaseObjectGroup', { objectGroup: found.group }); }
}

export async function removeRegistrations(records) {
  await Promise.all(records.map(record => rm(record.file, { force: true }).catch(() => {})));
}
