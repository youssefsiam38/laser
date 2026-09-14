import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeConfig, SAFETY } from './config.mjs';

const self = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part?.type === 'text' ? String(part.text ?? '') : '').join('');
}
function lastUser(request) {
  return [...(request.messages ?? [])].reverse().find(message => message.role === 'user');
}
function lastToolAfterUser(request) {
  const messages = request.messages ?? [];
  const user = messages.findLastIndex(message => message.role === 'user');
  return messages.slice(user + 1).some(message => message.role === 'tool');
}
function toolNames(request) { return (request.tools ?? []).map(tool => tool.function.name); }
function markdown(bytes) {
  const block = '# Resource section\n\n- bounded item\n- repeated item\n\n```text\nsynthetic output\n```\n\n';
  return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
}

export async function startProvider(config, countersFile) {
  let requests = 0;
  const routes = Object.create(null);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      if (!req.url?.endsWith('/chat/completions')) return void res.writeHead(404).end();
      requests++;
      if (requests > SAFETY.providerRequests) return void res.writeHead(503).end(JSON.stringify({ error: { message: 'resource request ceiling' } }));
      let request;
      try { request = JSON.parse(raw); } catch { return void res.writeHead(400).end(); }
      raw = '';
      const prompt = textOf(lastUser(request)?.content);
      const key = prompt.split(/\s+/)[0] || 'continuation';
      routes[key] = (routes[key] ?? 0) + 1;
      writeFileSync(countersFile, JSON.stringify({ requests, routes, lastToolNames: toolNames(request).slice(0, 20) }), { mode: 0o600 });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id: `synthetic-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'stub-1' };
      const frame = delta => res.write(sse({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }));
      frame({ role: 'assistant', content: '' });
      const finishText = async (text, { reasoning = '', chunks = 1, delay = 0 } = {}) => {
        if (reasoning) {
          const size = Math.max(1, Math.ceil(reasoning.length / chunks));
          for (let at = 0; at < reasoning.length; at += size) { frame({ reasoning_content: reasoning.slice(at, at + size) }); if (delay) await sleep(delay); }
        }
        const size = Math.max(1, Math.ceil(text.length / chunks));
        for (let at = 0; at < text.length; at += size) { frame({ content: text.slice(at, at + size) }); if (delay) await sleep(delay); }
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
      };
      const finishTool = toolCall => {
        const id = `call_${requests}`;
        frame({ tool_calls: [{ index: 0, id, type: 'function', function: { name: toolCall.name, arguments: '' } }] });
        frame({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolCall.args) } }] });
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
      };
      try {
        if (prompt.startsWith('resource:large-stream')) {
          await finishText(markdown(config.markdownBytes), { reasoning: 'r'.repeat(config.reasoningBytes), chunks: config.streamChunks, delay: config.streamDelayMs });
        } else if (prompt.startsWith('resource:start-child:') && !lastToolAfterUser(request)) {
          const match = /agent=([\w-]+)/.exec(prompt);
          if (!match || !toolNames(request).includes('start_agent')) throw new Error('start_agent unavailable');
          finishTool({ name: 'start_agent', args: { agent_name: match[1], subagent_name: `resource-child-${prompt.split(':')[2].split(/\s/)[0]}`, task: `resource:child:${prompt.split(':')[2].split(/\s/)[0]}`, worktree: false } });
        } else if (prompt.startsWith('resource:child:')) {
          await finishText('child-active-'.repeat(4096), { chunks: 200, delay: Math.max(1, Math.ceil(config.childHoldMs / 200)) });
        } else if (prompt.startsWith('resource:bash:') && !lastToolAfterUser(request)) {
          const background = prompt.includes(':bg:');
          const id = prompt.split(':').at(-1);
          const bytes = Number(/bytes=(\d+)/.exec(prompt)?.[1] ?? 16384);
          finishTool({ name: 'bash', args: { command: `node -e "process.stdout.write('x'.repeat(${bytes})+'-${id}\\n')"`, ...(background ? { background: true, notify: false } : {}) } });
        } else if (prompt.startsWith('resource:tool-large') && !lastToolAfterUser(request)) {
          finishTool({ name: 'bash', args: { command: `node -e "process.stdout.write('t'.repeat(${config.toolBytes}))"` } });
        } else {
          await finishText(`synthetic response ${requests}`);
        }
      } catch (error) {
        await finishText(`synthetic provider error ${error instanceof Error ? error.message : String(error)}`);
      }
      res.write('data: [DONE]\n\n'); res.end();
      request = null;
    });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

export function writeModels(agentDir, url) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { stub: { baseUrl: url, api: 'openai-completions', apiKey: 'stub-key', models: [{ id: 'stub-1', name: 'Synthetic', contextWindow: 1_000_000, maxTokens: 100_000 }] } } }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub-1', compaction: { enabled: false } }));
}

if (resolve(process.argv[1]) === self) {
  const root = process.argv[2];
  const config = modeConfig(process.argv[3] ?? 'quick');
  const provider = await startProvider(config, join(root, 'provider-counters.json'));
  writeModels(join(root, 'agent'), provider.url);
  writeFileSync(join(root, 'provider.json'), JSON.stringify({ url: provider.url }), { mode: 0o600 });
  process.once('SIGTERM', () => void provider.close().then(() => process.exit(0)));
  process.once('SIGINT', () => void provider.close().then(() => process.exit(0)));
}
