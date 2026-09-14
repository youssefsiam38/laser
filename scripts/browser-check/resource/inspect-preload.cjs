const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.RESOURCE_SOAK_INSPECT_DIR;
if (root && !process.versions.electron) {
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    inspector.open(0, '127.0.0.1', false);
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const record = { pid: process.pid, startToken: `linux:${boot}:${fields[19]}`, url: inspector.url() };
    const file = path.join(root, `${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const clean = () => { try { fs.rmSync(file, { force: true }); } catch {} };
    process.once('exit', clean);
  } catch (error) {
    process.stderr.write(`resource inspector unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
