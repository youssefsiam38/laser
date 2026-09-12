import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

// An allowlist, not a growing list of credential spellings. Callers add only
// explicit, disposable values; no inherited shell, proxy, preload or auth state.
export function isolatedEnvironment(root, node = process.execPath) {
  const env = { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    npm_config_cache: join(root, 'cache/npm'), npm_config_userconfig: join(root, 'config/npmrc'), GIT_CONFIG_GLOBAL: join(root, 'config/gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PLAYWRIGHT_OUTPUT_DIR: join(root, 'artifacts') };
  return env;
}
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function until(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  do {
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(check),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('check did not settle')), Math.max(1, end - Date.now())); }),
      ]);
      if (value) return value;
    } catch (error) { last = error.message; }
    finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, end - Date.now()))));
  } while (Date.now() < end);
  throw new Error(`Timed out after ${timeout}ms waiting for ${description}${last ? `: ${last}` : ''}`);
}
export function liveOwnedProcesses(records, processes) {
  const groups = new Set(records.map(record => record.pid));
  return processes.filter(p => groups.has(p.group) && p.state !== 'Z');
}
function processes() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return [{ pid: Number(name), group: Number(fields[2]), state: fields[0] }];
    } catch { return []; }
  });
}
export function lifecycle(root, env) {
  const records = [];
  let closed;
  return {
    records,
    spawn(command, args = [], options = {}) {
      if (closed) throw new Error('Cannot start a process after teardown.');
      mkdirSync(join(root, 'logs'), { recursive: true });
      const name = options.name ?? `process-${records.length}`;
      const log = createWriteStream(join(root, 'logs', `${name}.log`), { mode: 0o600 });
      const child = spawn(command, args, { cwd: root, ...options, env: { ...env, ...options.env, PATH: env.PATH }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const record = { name, pid: child.pid, error: null, exitCode: null };
      records.push(record);
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.on('error', error => { record.error = error.message; log.end(`${error.message}\n`); });
      child.on('close', code => { record.exitCode = code; log.end(); });
      return child;
    },
    close() {
      return closed ??= (async () => {
        const signal = name => { for (const { pid } of records.toReversed()) if (pid) { try { process.kill(-pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
        signal('SIGTERM');
        try { await until(() => liveOwnedProcesses(records, processes()).length === 0, 'owned processes to exit', 5000); } catch { signal('SIGKILL'); }
        await new Promise(resolve => setTimeout(resolve, 200));
        const survivors = liveOwnedProcesses(records, processes());
        console.log(`Processes left running: ${survivors.length ? survivors.map(p => p.pid).join(', ') : 'none'}`);
        return survivors;
      })();
    },
  };
}
