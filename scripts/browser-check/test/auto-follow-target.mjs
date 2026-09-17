import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { target as appTarget, configureStubProvider, checkout } from '../targets/app.mjs';
import { fixture, answer as sharedAnswer } from '../targets/fixtures.mjs';

const self = fileURLToPath(import.meta.url);
export { checkout, fixture };
export const target = runtime => appTarget(runtime, { provider: self });

const textOf = message => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).map(part => part.text ?? '').join('\n');

if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === '--provider') {
  const root = process.argv[3];
  const { startStubProvider, writeStubModels } = await import('../../../packages/worker/test/agents/stub-provider.ts');
  const provider = await startStubProvider(request => {
    const userIndex = request.messages.findLastIndex(message => message.role === 'user');
    const prompt = textOf(request.messages[userIndex]);
    if (prompt === 'Run auto-follow delayed tool group') {
      const step = request.messages.slice(userIndex + 1).filter(message => message.role === 'tool').length;
      if (step === 0) return { toolCall: { name: 'bash', args: { command: "printf 'first grouped result\\n'" } } };
      if (step === 1) return { toolCall: { name: 'bash', args: { command: "sleep 2; printf 'second grouped result\\n'" } } };
      return { text: 'Both grouped tools completed.' };
    }
    if (prompt === 'Render auto-follow markdown and code') {
      return {
        text: [
          'A paragraph that wraps across several lines while the viewport remains pinned to the live edge.',
          '',
          '```typescript',
          'export function measuredLiveEdge(values: readonly number[]) {',
          '  return values.every(value => value <= 2);',
          '}',
          '```',
          '',
          'The highlighted fence and this trailing paragraph both belong to the same growing row.',
        ].join('\n'),
        chunks: 80,
        chunkDelayMs: 12,
      };
    }
    return sharedAnswer(request);
  });
  writeStubModels(join(root, 'agent'), provider.url);
  configureStubProvider(root, provider.url);
  process.once('SIGTERM', () => void provider.close().then(() => process.exit(0)));
}
