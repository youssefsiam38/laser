// @vitest-environment happy-dom
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerTriggerPopover } from "../../src/components/assistant-ui/elements/composer-trigger-popover.aui.js";
import { useDirectoryPage } from "../../src/components/thread/use-directory-page.js";
import { matchProjectMention } from "../../src/components/thread/project-path.js";
import { explorerItems, explorerNavigation, explorerPageItem, mentionFormatter } from "../../src/components/thread/project-explorer-model.js";

// The listing validator is a lazy chunk (M16-T31) and these tests run on fake
// timers, which cannot advance a module load: load it once, here.
await import("../../src/components/thread/explorer-listing.js");

const request = vi.hoisted(() => vi.fn());
const client = { request };
vi.mock('@/runtime', () => ({ useLaserStable: () => ({ client }) }));
const inserted = vi.fn(), sent = vi.fn();
let container: HTMLDivElement, root: Root;
function Picker() {
  const [query, setQuery] = useState(''); const [open, setOpen] = useState(false);
  const page = useDirectoryPage('/project', query, open);
  const adapter = useMemo(() => ({ categories: () => [], categoryItems: () => [], search: () => [
    ...(page.navigation.previous ? [explorerPageItem('previous')] : []),
    ...explorerItems(page.entries, '/project'), ...(page.navigation.next ? [explorerPageItem('next')] : []),
  ] }), [page.entries, page.navigation.next, page.navigation.previous]);
  return <ComposerPrimitive.Unstable_TriggerPopoverRoot><ComposerPrimitive.Root>
    <ComposerPrimitive.Input />
    <ComposerTriggerPopover char="@" matcher={matchProjectMention} adapter={adapter} directive={{ onInserted: inserted, formatter: mentionFormatter }} navigation={explorerNavigation(page.navigation)} onQueryChange={setQuery} onOpenChange={setOpen} isLoading={page.loading} unavailableLabel={page.issue ? 'Update or retry this path.' : undefined} notice={<>{page.issue?.message}{page.retry && <button type="button" onClick={page.retry}>Try again</button>}</>} />
  </ComposerPrimitive.Root></ComposerPrimitive.Unstable_TriggerPopoverRoot>;
}
function Fixture() {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: sent });
  return <AssistantRuntimeProvider runtime={runtime}><Picker /></AssistantRuntimeProvider>;
}
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); request.mockReset(); inserted.mockReset(); sent.mockReset();
  request.mockImplementation(async (_method, params) => ({ path: params.path, home: '/home/test', entries: (params.path === '/project' ? [
    { name: 'node-one', kind: 'directory' }, { name: 'node-two', kind: 'directory' }, { name: 'server', kind: 'directory' },
  ] : [{ name: 'index.ts', kind: 'file' }]).filter(entry => entry.name.startsWith(params.explorer.prefix)).map(entry => ({ ...entry, path: params.path + '/' + entry.name, project: false })), truncated: false, commonPrefix: params.explorer.prefix === 'node' ? 'node-' : '' }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const input = () => container.querySelector('textarea')!;
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
async function type(text: string) {
  await act(async () => {
    input().focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().setSelectionRange(text.length, text.length); input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(150); }); }
async function key(key: string) { await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }); }
it.each([['@/', '/', ''], ['@..', '/', ''], ['@../', '/', ''], ['@/outside/ind', '/outside', 'ind'], ['@node', '/project', 'node'], ['@./node', '/project', 'node'], ['@server/', '/project/server', ''], ['@server/ind', '/project/server', 'ind']])('typing %s reads the correct directory and prefix', async (text, path, prefix) => {
  await type(text); await tick();
  expect(request).toHaveBeenLastCalledWith('pi/project/browse', { path, explorer: { mode: 'explorer', cwd: '/project', prefix, offset: 0, limit: 80 } });
  expect(options().length).toBeGreaterThan(0); expect(document.activeElement).toBe(input());
});
it('Enter on a folder continues, Backspace goes up, a file inserts the existing directive', async () => {
  await type('@ser'); await tick(); await key('Enter');
  expect(input().value).toBe('@server/'); expect(inserted).not.toHaveBeenCalled();
  await tick(); expect(options()[0]?.textContent).toContain('index.ts');
  await key('Backspace'); expect(input().value).toBe('@');
  await type('@server/ind'); await tick(); await key('Enter');
  expect(input().value).toBe(':file[server/index.ts] '); expect(inserted).toHaveBeenCalledOnce(); expect(sent).not.toHaveBeenCalled();
});
it('pointer and slash descend; Tab completes the common prefix without choosing a folder', async () => {
  await type('@node'); await tick(); await key('Tab'); expect(input().value).toBe('@node-'); expect(inserted).not.toHaveBeenCalled();
  await type('@ser'); await tick(); await key('/'); expect(input().value).toBe('@server/');
  await type('@ser'); await tick(); await act(async () => options()[0]!.click()); expect(input().value).toBe('@server/');
  expect(document.activeElement).toBe(input());
});
it('a slow read leaves typing and Escape responsive and never chooses stale results', async () => {
  let settle!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
  await type('@server/'); await tick(); await key('Tab'); expect(input().value).toBe('@server/');
  await type('@node'); await tick(); await key('Escape'); expect(input().value).toBe('@node');
  await act(async () => settle({ entries: [{ name: 'stale', path: '/project/server/stale', kind: 'file' }], truncated: false }));
  expect(container.querySelector('[role="listbox"]')).toBeNull(); expect(sent).not.toHaveBeenCalled();
});
it('continues an absolute directory and inserts an outside file with its absolute identity', async () => {
  request.mockResolvedValueOnce({ path: '/', home: '/home/test', entries: [{ name: 'outside', path: '/outside', kind: 'directory', project: false }], truncated: false, commonPrefix: 'outside' });
  await type('@/out'); await tick(); await key('Enter');
  expect(input().value).toBe('@/outside/'); await tick(); await key('Enter');
  expect(input().value).toBe(':file[/outside/index.ts] '); expect(sent).not.toHaveBeenCalled();
});
it('does not hijack deletion or Tab traversal of a selected text range', async () => {
  await type('@server/'); await tick();
  input().setSelectionRange(1, 8);
  const backspace = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(backspace); });
  expect(backspace.defaultPrevented).toBe(false);
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(tab); });
  expect(tab.defaultPrevented).toBe(false); expect(inserted).not.toHaveBeenCalled();
});
it('a refusal has no retry or no-match advice; a read failure recovers through retry', async () => {
  await type('@~'); await tick();
  expect(container.textContent).toContain('Home shortcuts'); expect(container.textContent).not.toContain('No matches');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Try again')).toBe(false);
  expect(request).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error('transport'));
  await type('@server/'); await tick();
  expect(container.textContent).toContain('Couldn’t read this folder.'); expect(container.textContent).not.toContain('No matches');
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again');
  expect(retry).toBeDefined(); await act(async () => retry!.click()); await tick();
  expect(options()[0]?.getAttribute('aria-label')).toBe('server/index.ts');
});
it.each(['a]b.md', 'a\nb.md', ':file[a].md'])('selects awkward names as a reversible plain path without a wrong chip or send: %j', async name => {
  request.mockResolvedValueOnce({ path: '/project', home: '/home/test', entries: [{ name, path: '/project/' + name, kind: 'file', project: false }], truncated: false, commonPrefix: name });
  await type('@'); await tick(); await key('Enter');
  expect(JSON.parse(input().value.trim())).toBe(name);
  expect(mentionFormatter.parse(input().value).every(part => part.kind === 'text')).toBe(true);
  expect(sent).not.toHaveBeenCalled(); expect(inserted).toHaveBeenCalledOnce();
});
it('root Backspace is not prevented, while folder-up still is', async () => {
  await type('@/'); await tick();
  const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(event); }); expect(event.defaultPrevented).toBe(false);
  await type('@server/'); await tick();
  const up = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(up); }); expect(up.defaultPrevented).toBe(true); expect(input().value).toBe('@');
});
it('literal pagination and sentinel-like filenames keep unique React/DOM identities and keyboard selection', async () => {
  const names = ['next', 'previous', '__page:next', 'action:006e006500780074'];
  const reply = { path: '/project', home: '/home/test', entries: names.map(name => ({ name, path: '/project/' + name, kind: 'file', project: false })), truncated: true, nextOffset: 80, commonPrefix: '' };
  const errors = vi.spyOn(console, 'error');
  try {
    request.mockResolvedValue(reply);
    await type('@'); await tick();
    expect(new Set(options().map(row => row.id)).size).toBe(options().length);
    for (const name of names) {
      const selected = options().find(row => row.getAttribute('aria-selected') === 'true');
      expect(selected?.getAttribute('aria-label')).toBe(name);
      expect(input().getAttribute('aria-activedescendant')).toBe(selected?.id);
      await key('ArrowDown');
    }
    expect(options().find(row => row.getAttribute('aria-selected') === 'true')?.textContent).toContain('More entries');
    await key('Enter'); await tick();
    expect(new Set(options().map(row => row.id)).size).toBe(options().length);
    expect(options()[0]?.textContent).toContain('Previous entries');
    expect(container.textContent).toContain('4 results');
    await key('ArrowDown'); await key('Enter'); expect(input().value).toBe(':file[next] ');
    expect(sent).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key|unique.*key/u);
  } finally { errors.mockRestore(); }
});

it('More entries reads one next page while keeping the composer query', async () => {
  request.mockResolvedValueOnce({ path: '/project', home: '/home/test', entries: [], truncated: true, nextOffset: 80, commonPrefix: '' });
  await type('@'); await tick(); await key('Enter'); await tick();
  expect(input().value).toBe('@'); expect(request.mock.calls.at(-1)?.[1].explorer.offset).toBe(80);
  expect(inserted).not.toHaveBeenCalled();
});
