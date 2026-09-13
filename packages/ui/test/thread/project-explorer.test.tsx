// @vitest-environment happy-dom
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerTriggerPopover } from "../../src/components/assistant-ui/elements/composer-trigger-popover.aui.js";
import { useProjectFileSearch } from "../../src/components/thread/use-project-file-search.js";
import { matchProjectMention } from "../../src/components/thread/project-path.js";
import { explorerItems, explorerNavigation } from "../../src/components/thread/project-explorer-model.js";

const request = vi.hoisted(() => vi.fn());
const client = { request };
vi.mock('@/runtime', () => ({ useLaserStable: () => ({ client }) }));
const inserted = vi.fn(), sent = vi.fn();
let container: HTMLDivElement, root: Root;
function Picker() {
  const [query, setQuery] = useState(''); const [open, setOpen] = useState(false);
  const search = useProjectFileSearch('/project', query, open);
  const adapter = useMemo(() => ({ categories: () => [], categoryItems: () => [], search: () => [
    ...explorerItems(search.files, '/project'), ...(search.next ? [{ id: 'next', type: 'page', label: 'More entries…' }] : []),
  ] }), [search.files, search.next]);
  return <ComposerPrimitive.Unstable_TriggerPopoverRoot><ComposerPrimitive.Root>
    <ComposerPrimitive.Input />
    <ComposerTriggerPopover char="@" matcher={matchProjectMention} adapter={adapter} directive={{ onInserted: inserted }} navigation={explorerNavigation(search)} onQueryChange={setQuery} onOpenChange={setOpen} isLoading={search.loading} />
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
it.each([['@/', '/project', ''], ['@node', '/project', 'node'], ['@./node', '/project', 'node'], ['@server/', '/project/server', ''], ['@server/ind', '/project/server', 'ind']])('typing %s reads the correct directory and prefix', async (text, path, prefix) => {
  await type(text); await tick();
  expect(request).toHaveBeenLastCalledWith('pi/project/browse', { path, explorer: { mode: 'explorer', root: '/project', prefix, offset: 0, limit: 80 } });
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
it('More entries reads one next page while keeping the composer query', async () => {
  request.mockResolvedValueOnce({ path: '/project', home: '/home/test', entries: [], truncated: true, nextOffset: 80, commonPrefix: '' });
  await type('@'); await tick(); await key('Enter'); await tick();
  expect(input().value).toBe('@'); expect(request.mock.calls.at(-1)?.[1].explorer.offset).toBe(80);
  expect(inserted).not.toHaveBeenCalled();
});
