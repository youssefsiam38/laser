import { readFile, readdir, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

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
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Inspector evaluation failed.');
  return options.returnByValue ? response.result?.value : response.result;
}

export async function scalarCounters(client, instanceId, kind) {
  const fn = kind === 'host' ? `function(){
    const s=this; const sockets=Array.from(s.clients ?? []);
    const deliveries=Array.from((s.transcripts ?? new Map()).values());
    const workers=Array.from(s.pool?.entries?.values?.() ?? []);
    const tasks=s.tasks?.list?.() ?? [];
    const attachmentSets=Array.from(s.attached?.values?.() ?? []);
    const attachedPaths=new Set(); for(const paths of attachmentSets) for(const path of paths) attachedPaths.add(path);
    const runs=s.runs?.list?.() ?? []; const terminalRuns=new Set(['completed','blocked','failed','cancelled']);
    const attentionRows=Array.from(s.attention?.live?.values?.() ?? []);
    return { kind:'host', connections:sockets.length, bufferedBytes:sockets.reduce((n,w)=>n+(w.bufferedAmount||0),0),
      queuedSockets:sockets.filter(w=>(w.bufferedAmount||0)>0).length,
      attachmentRefs:attachmentSets.reduce((n,paths)=>n+(paths?.size||0),0), attachedPaths:attachedPaths.size,
      runningSessions:workers.reduce((n,w)=>n+(w.running?.size||0),0), liveRuns:runs.filter(run=>!terminalRuns.has(run.status)).length,
      attentionDialogs:attentionRows.reduce((n,row)=>n+(row.dialogs?.size||0),0),
      transcriptLoaded:deliveries.reduce((n,d)=>n+(d.loaded?.size||0),0), transcriptLoading:deliveries.reduce((n,d)=>n+(d.loading?.size||0),0),
      loadDeliveries:Array.from(s.loadDeliveries?.values?.() ?? []).reduce((n,set)=>n+set.size,0),
      pendingLogRows:s.pendingLogRows?.length||0, tasks:tasks.length, runningTasks:tasks.filter(t=>t.status==='running').length,
      taskStatuses:tasks.reduce((o,t)=>(o[t.status]=(o[t.status]||0)+1,o),{}), workers:workers.length,
      logs:s.logs?.stats?.() ?? null, memory:process.memoryUsage() };
  }` : `function(){
    const sessions=Array.from(this.sessions?.values?.() ?? []); const rows=[]; const pending=[];
    for(const item of sessions){ const driver=item.driver ?? item; const replay=item.replay ?? item.buffer;
      let entries=null; try { entries=driver.entries?.().entries?.length ?? null; } catch {}
      try { if(typeof driver.pendingUi==='function') pending.push(...driver.pendingUi()); } catch {}
      rows.push({ entries, replayCount:replay?.size ?? null, replayBytes:replay?.bytes ?? null }); }
    const taskRows=[]; const bySession=this.tasks?.bySession;
    for(const value of bySession?.values?.() ?? []) for(const task of value.values?.() ?? value) taskRows.push(task);
    const runningTools=Array.from(this.runningTools?.values?.() ?? []).reduce((n,set)=>n+(set?.size||0),0);
    return { kind:'worker', sessions:sessions.length, opening:this.opening?.size||0,
      entries:rows.reduce((n,r)=>n+(r.entries||0),0), replayCount:rows.reduce((n,r)=>n+(r.replayCount||0),0),
      replayBytes:rows.reduce((n,r)=>n+(r.replayBytes||0),0), tasks:taskRows.length,
      runningTasks:taskRows.filter(task=>task.status==='running').length, runningTools,
      pendingQuestions:pending.filter(request=>!request.toolCallId).length,
      pendingApprovals:pending.filter(request=>Boolean(request.toolCallId)).length, memory:process.memoryUsage() };
  }`;
  return callFunction(client, instanceId, fn, { returnByValue: true });
}

export async function tailBufferCounters(client, moduleUrl) {
  const found = await queryInstances(client, moduleUrl, 'TailBuffer', { exact: null, minimum: 1 });
  try {
    return await callFunction(client, found.objectsId, `function(){ const a=Array.from(this); const sizes=a.map(x=>x.size||0); return {count:a.length,bytes:sizes.reduce((n,x)=>n+x,0),maxBytes:Math.max(0,...sizes)}; }`, { returnByValue: true });
  } finally { await client.send('Runtime.releaseObjectGroup', { objectGroup: found.group }); }
}

export async function removeRegistrations(records) {
  await Promise.all(records.map(record => rm(record.file, { force: true }).catch(() => {})));
}

export function inspectorLabel(record) { return basename(record.file ?? String(record.pid)); }
