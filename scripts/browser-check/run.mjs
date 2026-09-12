#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCheck } from './index.mjs';

const { values } = parseArgs({ options: {
  target: { type: 'string' }, url: { type: 'string' }, script: { type: 'string' }, fixture: { type: 'string', default: 'empty' },
  matrix: { type: 'boolean' }, touch: { type: 'boolean' }, 'reduced-motion': { type: 'boolean' },
  artifacts: { type: 'string' }, playwright: { type: 'string' }, chrome: { type: 'string' }, timeout: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/browser-check/run.mjs --target ./target.mjs [--fixture long] [--script ./check.mjs] [--matrix] [--touch]\nOr --url http://127.0.0.1:3000 for an existing server (no stored-theme matrix).\nArtifacts default to /tmp/browser-check; --playwright and --chrome select explicit executables/modules.');
} else {
  try {
    if (!values.target && !values.url) throw new Error('Pass --target ./target.mjs or --url http://127.0.0.1:3000; see --help.');
    const config = values.target ? await import(pathToFileURL(resolve(values.target)).href) : {};
    const script = values.script ? (await import(pathToFileURL(resolve(values.script)).href)).default : undefined;
    const evidence = await browserCheck({ ...config, target: values.url ?? config.target, fixtureName: values.fixture, matrix: values.matrix, touch: values.touch,
      reducedMotion: values['reduced-motion'], artifacts: values.artifacts, playwright: values.playwright, chrome: values.chrome,
      ...(values.timeout ? { timeout: Number(values.timeout) } : {}),
    }, script);
    if (evidence.contactSheet) console.log(`Contact sheet: ${evidence.contactSheet}`);
    if (evidence.survivors.length) process.exitCode = 1;
  } catch (error) { console.error(`Browser check failed: ${error.message}`); process.exitCode = 1; }
}
