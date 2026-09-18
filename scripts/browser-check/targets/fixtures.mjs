import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function fixturePlan(name) {
  const counts = { empty: 0, short: 4, long: 240, history: 240, huge: 2000, tools: 4, agents: 2, projects: 4, mcp: 2 };
  if (!(name in counts)) throw new Error(`Unknown fixture ${name}; choose ${Object.keys(counts).join(', ')}.`);
  return Array.from({ length: name === 'projects' ? 10 : 1 }, (_, project) => ({
    name: `project-${String(project + 1).padStart(2, '0')}`,
    sessions: Array.from({ length: name === 'projects' ? 15 : name === 'empty' ? 0 : 1 }, (_, session) => ({
      name: `${name} conversation ${session + 1}`,
      prompts: Array.from({ length: counts[name] / 2 }, (_, turn) => {
        const marker = `Review checkpoint ${turn + 1}: verify the implementation and explain the next step.`;
        return name === 'history' ? `${marker}\n\nSynthetic retained body ${turn + 1}: ${'bounded history evidence. '.repeat(320)}` : marker;
      }),
    })),
  }));
}
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(part => part.text ?? '').join('\n');
export function answer(request) {
  const last = request.messages.at(-1);
  const user = request.messages.findLast(message => message.role === 'user');
  const prompt = textOf(user);
  const system = textOf(request.messages.find(message => message.role === 'system' || message.role === 'developer'));
  const names = (request.tools ?? []).map(tool => tool.function.name);
  if (prompt === 'Discover fixture tools') {
    const turn = request.messages.slice(request.messages.findLastIndex(message => message.role === 'user') + 1);
    const step = turn.filter(message => message.role === 'tool').length;
    const calls = [
      { name: 'mcp', args: { search: 'echo', detail: 'names' } },
      { name: 'mcp', args: { search: 'echo' } },
      { name: 'mcp', args: { describe: 'fixture_echo' } },
      { name: 'mcpScript', args: { code: 'emit(await tools.search({query:"echo",detail:"names"}));' } },
      { name: 'mcp', args: { tool: 'fixture_echo', args: { text: 'discovery acceptance' } } },
    ];
    return calls[step] ? { toolCall: calls[step] } : { text: 'Discovery fixture complete.' };
  }
  if (system.includes('fixture-failed')) return { status: 400, body: { error: { message: 'Deterministic fixture failure', type: 'invalid_request_error' } } };
  if (system.includes('fixture-asking') || prompt.startsWith('fixture-asking:')) {
    const echo = names.find(name => name.endsWith('_echo'));
    if (echo && last?.role !== 'tool') return { toolCall: { name: echo, args: { text: 'Please approve this fixture call.' } } };
  }
  if (last?.role === 'user' && prompt === 'Start fixture-failed') return { toolCall: { name: 'start_agent', args: { agent_name: 'default', subagent_name: 'fixture-failed', task: 'fixture-failed: demonstrate a provider error.', worktree: false } } };
  if (last?.role === 'user' && prompt === 'Start fixture-asking') return { toolCall: { name: 'start_agent', args: { agent_name: 'default', subagent_name: 'fixture-asking', task: 'fixture-asking: call the fixture echo tool.', worktree: false } } };
  // A long answer that really streams: many small deltas over a few seconds,
  // for watching another surface while a turn is in flight.
  if (prompt.startsWith('fixture-stream')) {
    const paragraph = Array.from({ length: 40 }, (_, i) => `Streaming line ${i + 1}: the implementation follows the project boundaries.`).join('\n\n');
    return { text: paragraph, chunks: 120, chunkDelayMs: 40 };
  }
  // Output past the transcript's per-body excerpt and under the shell tool's own cap.
  if (last?.role === 'user' && prompt === 'Run fixture large output') return { toolCall: { name: 'bash', args: { command: "seq 1 1100 | awk '{printf \"ok  test %05d passed in the fixture suite\\n\", $1}'" } } };
  if (last?.role === 'user' && prompt.startsWith('Run labelled fixture tool')) {
    const caseLabel = prompt.slice('Run labelled fixture tool'.length).trim();
    const activityLabel = caseLabel ? `checking-${caseLabel}-row` : 'checking-layout-balance';
    return { reasoning: 'Inspect the selectable activity row before running the command.', toolCall: { name: 'bash', args: { command: "sleep 12; printf 'labelled fixture complete\\n'", activity_label: activityLabel } } };
  }
  if (last?.role === 'user' && prompt === 'Run labelled fixture error') return { toolCall: { name: 'read', args: { path: 'missing-fixture-config.txt', activity_label: 'reading-missing-config' } } };
  if (last?.role === 'user' && prompt.startsWith('Run mixed labelled fixture')) {
    const caseLabel = prompt.slice('Run mixed labelled fixture'.length).trim() || 'build-config';
    const output = `${caseLabel.replaceAll('-', ' ')} body`;
    const encoded = [...`${output}\n`].map(character => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');
    return { toolCall: { name: 'bash', args: { command: `printf '${encoded}'`, activity_label: `reading-${caseLabel}-body` } } };
  }
  if (last?.role === 'user' && prompt === 'Run generic fixture tool' && names.includes('inspect_fleet')) return { toolCall: { name: 'inspect_fleet', args: {} } };
  if (prompt === 'Run fixture activity sequence') {
    const turn = request.messages.slice(request.messages.findLastIndex(message => message.role === 'user') + 1);
    const step = turn.filter(message => message.role === 'tool').length;
    const calls = [
      { name: 'bash', args: { command: "printf 'first activity complete\\n'", activity_label: 'checking-first-activity' } },
      { name: 'read', args: { path: 'missing-sequence-config.txt', activity_label: 'reading-second-activity' } },
    ];
    return calls[step] ? { toolCall: calls[step] } : { text: 'Activity sequence complete.' };
  }
  if (last?.role === 'user' && prompt === 'Run fixture tools') return { toolCall: { name: 'bash', args: { command: "printf 'fixture tool output\\n'" } } };
  const goal = /<goal_id>\s*([^\s<>]+)\s*<\/goal_id>/.exec(prompt)?.[1];
  if (last?.role === 'user' && goal && names.includes('goal_complete')) return { toolCall: { name: 'goal_complete', args: { goal_id: goal, summary: 'Verified the fixture implementation and its focused checks.' } } };
  return { text: `Checkpoint ${/checkpoint (\d+)/.exec(prompt)?.[1] ?? 'complete'} is complete.\n\nThe implementation follows the project boundaries. Run the focused tests, then inspect the resulting changes.`, ...(prompt.includes('fixture reasoning') ? { reasoning: 'First inspect the boundary, then verify the result with a focused check.' } : {}) };
}

export async function fixture(target, runtime, name) {
  const plan = fixturePlan(name);
  await target.rpc('pi/setup/complete', { completed: true });
  const sessions = [];
  const projects = [];
  const verified = [];
  const settle = path => runtime.until(async () => !(await target.rpc('session/load', { path })).state.isStreaming, `session ${path} to settle`, 120000);
  async function prompt(path, text) {
    const result = await target.rpc('session/prompt', { path, content: [{ type: 'text', text }] });
    if (!result.accepted) throw new Error(`Fixture prompt was refused: ${text}`);
    await settle(path);
  }
  for (const project of plan) {
    const cwd = join(runtime.root, project.name); mkdirSync(cwd, { recursive: true }); projects.push(cwd);
    await target.rpc('pi/project/add', { cwd });
    await target.rpc('pi/project/trust', { cwd, trusted: true, remember: true });
    if (name === 'mcp' || name === 'agents') {
      await target.rpc('mcp/save', { cwd, scope: 'global', server: { name: 'fixture', transport: { kind: 'stdio', command: runtime.node, args: [fileURLToPath(new URL('../../../packages/worker/test/mcp/fixtures/stdio-server.mjs', import.meta.url))] }, tools: { alwaysLoad: name === 'agents', approve: name === 'agents' }, startup: 'on-demand' } });
      await target.rpc('mcp/inspect', { cwd, scope: 'global', name: 'fixture' });
    }
    for (const session of project.sessions) {
      const { state } = await target.rpc('session/new', { cwd });
      const path = state.path; sessions.push(path);
      await target.rpc('pi/model/set', { path, model: { provider: 'stub', id: 'stub-1' } });
      for (const text of session.prompts) await prompt(path, text);
      await target.rpc('pi/session/rename', { path, name: session.name });
      if (name === 'tools') {
        await prompt(path, 'Show fixture reasoning');
        await prompt(path, 'Run fixture tools');
        await target.rpc('session/goal/action', { path, action: { action: 'start', objective: 'Verify the fixture implementation.' } });
        await settle(path);
      }
      if (name === 'agents') {
        await prompt(path, 'Start fixture-failed');
        await prompt(path, 'Start fixture-asking');
        await runtime.until(async () => {
          const { runs } = await target.rpc('agents/runs/list', { path });
          return runs.some(run => run.status === 'failed') && runs.some(run => run.status === 'needs_input');
        }, 'one failed child and one asking child', 120000);
      }
      const { entries } = await target.rpc('pi/session/entries', { path });
      const messages = entries.filter(entry => entry.type === 'message').map(entry => entry.message);
      if (!['tools', 'agents'].includes(name) && messages.length !== session.prompts.length * 2) throw new Error(`Fixture ${name}: expected ${session.prompts.length * 2} persisted messages, got ${messages.length}.`);
      if (name === 'tools') {
        const reasoning = messages.some(message => message.content?.some(part => part.type === 'thinking'));
        const results = messages.filter(message => message.role === 'toolResult' && !message.isError).map(message => message.toolName);
        if (!reasoning || !results.includes('bash') || !results.includes('goal_complete')) throw new Error('Tools fixture did not persist reasoning, successful shell output and an accepted goal completion.');
      }
      verified.push({ path, messages: messages.length });
    }
  }
  return { name, project: projects[0], path: sessions[0], projects, sessions, verified, expectedMessages: ['long', 'history'].includes(name) ? 240 : name === 'huge' ? 2000 : undefined };
}
