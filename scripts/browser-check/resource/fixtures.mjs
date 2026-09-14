import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff; for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
export function syntheticPng(side, index) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const header = Buffer.alloc(13); header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(1 + side * 4); row[0] = 0;
  for (let x = 0; x < side; x++) { row[1 + x * 4] = (index * 41 + x) & 255; row[2 + x * 4] = (index * 67) & 255; row[3 + x * 4] = (index * 97) & 255; row[4 + x * 4] = 255; }
  const pixels = Buffer.alloc(row.length * side); for (let y = 0; y < side; y++) row.copy(pixels, y * row.length);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export function imagePayload(config) {
  return Array.from({ length: config.images }, (_, index) => {
    const bytes = syntheticPng(config.imageSide, index + 1);
    return { index: index + 1, bytes, hash: createHash('sha256').update(bytes).digest('hex'), logicalBytes: config.imageSide ** 2 * 4 };
  });
}

export async function settle(rpc, path, until, timeoutMs) {
  return until(async () => !(await rpc('session/load', { path })).state.isStreaming, `session ${path.split('/').at(-1)} to settle`, timeoutMs);
}
export async function prompt(rpc, path, text, until, timeoutMs) {
  const result = await rpc('session/prompt', { path, content: [{ type: 'text', text }] });
  if (!result.accepted) throw new Error(`Synthetic prompt was refused: ${text.split(/\s+/)[0]}`);
  await settle(rpc, path, until, timeoutMs);
}
export async function createSessions(check, config) {
  const sessions = [];
  for (let p = 0; p < check.fixture.projects.length; p++) {
    const cwd = check.fixture.projects[p];
    for (let s = 0; s < config.sessionsPerProject; s++) {
      const created = await check.rpc('session/new', { cwd }); const path = created.state.path;
      await check.rpc('pi/model/set', { path, model: { provider: 'stub', id: 'stub-1' } });
      const alias = `R${p + 1}-S${s + 1}`;
      const messages = p === 0 && s < config.longSessions ? config.longMessages : 4;
      const turns = messages / 2;
      for (let turn = 0; turn < turns; turn++) await prompt(check.rpc, path, `seed:${alias}:${turn + 1}`, async (fn, label, timeout) => {
        const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolveDelay => setTimeout(resolveDelay, 20)); } throw new Error(`Timed out waiting for ${label}.`);
      }, config.phaseTimeoutMs);
      await check.rpc('pi/session/rename', { path, name: alias });
      sessions.push({ path, cwd, alias, project: p + 1, ordinal: s + 1, messages, groupRows: config.sessionsPerProject });
    }
  }
  return sessions;
}
