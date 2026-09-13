/**
 * The app target with a provider that streams a real reply one small delta at
 * a time, so a browser check can watch the transcript under streaming rather
 * than after it. Everything else — host, fixtures, theme, RPC — is the app
 * target's (`targets/app.mjs`); only the provider process differs.
 *
 * A prompt of the form `Stream <n> deltas every <ms> ms` is answered with
 * exactly `n` SSE content frames spaced by `ms` (0 sends them as fast as the
 * socket accepts them, which is faster than a display refresh). Every other
 * prompt is answered by the shared fixture script, so seeding a conversation
 * behaves exactly as it does for `targets/app.mjs`.
 */
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { target as appTarget, configureStubProvider, checkout } from './app.mjs';
import { answer } from './fixtures.mjs';

const self = fileURLToPath(import.meta.url);
export { checkout };
export { fixture } from './fixtures.mjs';

export async function target(runtime) {
  return appTarget(runtime, { provider: self });
}

/** `Stream 500 deltas every 4 ms` → 500 content frames, 4 ms apart. */
export function streamPlan(prompt) {
  const match = /Stream (\d+) deltas every (\d+) ms/.exec(prompt ?? '');
  if (!match) return undefined;
  return { count: Math.min(Number(match[1]), 5000), delayMs: Number(match[2]) };
}

/** One delta's text. Ordinary prose, so Markdown and wrapping do real work. */
export const deltaText = (index, total) =>
  index === 0 ? 'Reviewing the checkpoint: ' : index === total - 1 ? ' Done.' : `${index % 12 === 11 ? '\n\n' : ''}step ${index} of ${total} verified, `;

const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(part => part.text ?? '').join('\n');
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const sleep = ms => new Promise(done => setTimeout(done, ms));

if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === '--provider') {
  const root = process.argv[3];
  const { writeStubModels } = await import(join(checkout, 'packages/worker/test/agents/stub-provider.ts'));
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', async () => {
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
      const request = JSON.parse(body);
      const base = { id: `chatcmpl-${++calls}`, object: 'chat.completion.chunk', created: 1, model: 'stub-1' };
      const usage = { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 };
      const prompt = textOf(request.messages.findLast(message => message.role === 'user'));
      const plan = streamPlan(prompt);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
      if (plan) {
        for (let index = 0; index < plan.count; index++) {
          if (res.writableEnded) return;
          res.write(sse({ ...base, choices: [{ index: 0, delta: { content: deltaText(index, plan.count) }, finish_reason: null }] }));
          if (plan.delayMs) await sleep(plan.delayMs);
        }
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }));
      } else {
        const scripted = answer(request);
        if ('toolCall' in scripted) {
          const id = scripted.toolCall.id ?? `call_${calls}`;
          res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: scripted.toolCall.name, arguments: '' } }] }, finish_reason: null }] }));
          res.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(scripted.toolCall.args) } }] }, finish_reason: null }] }));
          res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }));
        } else {
          if (scripted.reasoning) res.write(sse({ ...base, choices: [{ index: 0, delta: { reasoning_content: scripted.reasoning }, finish_reason: null }] }));
          res.write(sse({ ...base, choices: [{ index: 0, delta: { content: scripted.text ?? '' }, finish_reason: null }] }));
          res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }));
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  writeStubModels(join(root, 'agent'), url);
  configureStubProvider(root, url);
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
