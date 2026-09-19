// @vitest-environment happy-dom
import { act, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type Unstable_TriggerItem } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerTriggerPopover } from "../../src/components/assistant-ui/elements/composer-trigger-popover.aui.js";
import { useDirectoryPage } from "../../src/components/thread/use-directory-page.js";
import { projectMentionFormatter } from "../../src/components/thread/project-path.js";
import { ComposerMentionField } from "../../src/components/thread/composer-mention-tags.js";
import { createFinishedMentions, type FinishedMentions } from "../../src/components/thread/finished-mentions.js";
import { explorerItems, explorerNavigation, explorerPageItem } from "../../src/components/thread/project-explorer-model.js";

// The listing validator is a lazy chunk (M16-T31) and these tests run on fake
// timers, which cannot advance a module load: load it once, here.
await import("../../src/components/thread/explorer-listing.js");

const request = vi.hoisted(() => vi.fn());
const client = { request };
vi.mock('@/runtime', () => ({ useLaserStable: () => ({ client }) }));
const inserted = vi.fn(), sent = vi.fn();
let container: HTMLDivElement, root: Root;
// The wiring under test is the composer's own (`Composer.tsx`): the picker's
// matcher and its insertion both go through one record of finished mentions,
// and the draft's tag layer reads the same record.
function Picker() {
  const [query, setQuery] = useState(''); const [open, setOpen] = useState(false);
  const store = useRef<FinishedMentions>(undefined);
  store.current ??= createFinishedMentions();
  const mentions = store.current;
  const page = useDirectoryPage('/project', query, open);
  const adapter = useMemo(() => ({ categories: () => [], categoryItems: () => [], search: () => [
    ...(page.navigation.previous ? [explorerPageItem('previous')] : []),
    ...explorerItems(page.entries, '/project'), ...(page.navigation.next ? [explorerPageItem('next')] : []),
  ] }), [page.entries, page.navigation.next, page.navigation.previous]);
  const onInserted = (item: Unstable_TriggerItem) => { inserted(item); mentions.noteInsertion(item); };
  return <ComposerPrimitive.Unstable_TriggerPopoverRoot><ComposerPrimitive.Root>
    <ComposerMentionField mentions={mentions} className="composer-text" />
    <ComposerTriggerPopover char="@" matcher={mentions.matcher} adapter={adapter} directive={{ onInserted, formatter: projectMentionFormatter }} navigation={explorerNavigation(page.navigation)} onQueryChange={setQuery} onOpenChange={setOpen} isLoading={page.loading} unavailableLabel={page.issue ? 'Update or retry this path.' : undefined} notice={<>{page.issue?.message}{page.retry && <button type="button" onClick={page.retry}>Try again</button>}</>} />
    <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
  </ComposerPrimitive.Root></ComposerPrimitive.Unstable_TriggerPopoverRoot>;
}
function Fixture() {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: sent });
  return <AssistantRuntimeProvider runtime={runtime}><Picker /></AssistantRuntimeProvider>;
}
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); request.mockReset(); inserted.mockReset(); sent.mockReset();
  request.mockImplementation(async (_method, params) => {
    const canonical = params.path === '.' ? '/project' : params.path === '~' || params.path === '%USERPROFILE%' ? '/home/test' : params.path === '..' ? '/home' : params.path.startsWith('/') ? params.path : `/project/${params.path}`;
    const entries = canonical === '/project' ? [
      { name: 'node-one', kind: 'directory' }, { name: 'node-two', kind: 'directory' }, { name: 'server', kind: 'directory' },
    ] : [{ name: 'index.ts', kind: 'file' }];
    return { path: canonical, home: '/home/test', parent: canonical.slice(0, canonical.lastIndexOf('/')) || '/', entries: entries.filter(entry => entry.name.startsWith(params.explorer.prefix)).map(entry => ({ ...entry, path: `${canonical}/${entry.name}`.replace('//', '/'), project: false })), truncated: false, commonPrefix: params.explorer.prefix === 'node' ? 'node-' : '' };
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const input = () => container.querySelector('textarea')!;
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const listbox = () => container.querySelector('[role="listbox"]');
const tags = () => [...container.querySelectorAll<HTMLElement>('[data-slot="composer-mention-tag"]')];
async function type(text: string, caret = text.length) {
  await act(async () => {
    input().focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().setSelectionRange(caret, caret); input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** One character at a time, at the caret, the way a person produces a sentence. */
async function typeOn(suffix: string): Promise<string[]> {
  const opened: string[] = [];
  for (const char of suffix) {
    const at = input().selectionStart;
    const next = input().value.slice(0, at) + char + input().value.slice(at);
    await type(next, at + 1);
    if (listbox()) opened.push(next);
  }
  return opened;
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(150); }); }
async function key(key: string) { await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }); }
it.each([['@/', '/', ''], ['@..', '..', ''], ['@../', '..', ''], ['@/outside/ind', '/outside', 'ind'], ['@node', '.', 'node'], ['@./node', '.', 'node'], ['@server/', 'server', ''], ['@server/ind', 'server', 'ind'], ['@~', '~', ''], ['@~/ind', '~', 'ind'], ['@%USERPROFILE%\\ind', '%USERPROFILE%', 'ind'], ['@C:\\Users\\me\\ind', 'C:/Users/me', 'ind']])('typing %s sends the host the person’s spelling and prefix', async (text, path, prefix) => {
  await type(text); await tick();
  expect(request).toHaveBeenLastCalledWith('pi/project/browse', { path, explorer: { mode: 'explorer', cwd: '/project', prefix, offset: 0, limit: 80 } });
  expect(options().length).toBeGreaterThan(0); expect(document.activeElement).toBe(input());
});
it('Enter and click insert readable paths while slash still descends', async () => {
  await type('@ser'); await tick(); await key('Enter');
  expect(input().value).toBe('@./server/ '); expect(inserted).toHaveBeenCalledOnce(); expect(sent).not.toHaveBeenCalled();
  await type('@ser'); await tick(); await act(async () => options()[0]!.click());
  expect(input().value).toBe('@./server/ '); expect(inserted).toHaveBeenCalledTimes(2);
  await type('@ser'); await tick(); await key('/'); expect(input().value).toBe('@server/');
  await tick(); expect(options()[0]?.textContent).toContain('index.ts');
  await key('Enter'); expect(input().value).toBe('@./server/index.ts ');
});
it('Tab completes the common prefix without choosing a folder', async () => {
  await type('@node'); await tick(); await key('Tab'); expect(input().value).toBe('@node-'); expect(inserted).not.toHaveBeenCalled();
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
  expect(input().value).toBe('@/outside/ '); expect(sent).not.toHaveBeenCalled();
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
it('a host refusal has no retry or no-match advice; a read failure recovers through retry', async () => {
  request.mockResolvedValueOnce({ path: '/outside', home: '/home/test', entries: [], truncated: false, commonPrefix: '', error: 'You do not have permission to open this folder.', errorKind: 'refusal' });
  await type('@/outside/'); await tick();
  expect(container.textContent).toContain('permission to open this folder'); expect(container.textContent).not.toContain('No matches');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Try again')).toBe(false);
  request.mockRejectedValueOnce(new Error('transport'));
  await type('@server/'); await tick();
  expect(container.textContent).toContain('Couldn’t read this folder.'); expect(container.textContent).not.toContain('No matches');
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again');
  expect(retry).toBeDefined(); await act(async () => retry!.click()); await tick();
  expect(options()[0]?.getAttribute('aria-label')).toBe('server/index.ts');
});
it.each(['a]b.md', 'a\nb.md', ':file[a].md', 'my folder.md', 'quote"name.md'])('selects awkward names as a readable reversible quoted path without sending: %j', async name => {
  request.mockResolvedValueOnce({ path: '/project', home: '/home/test', entries: [{ name, path: '/project/' + name, kind: 'file', project: false }], truncated: false, commonPrefix: name });
  await type('@'); await tick(); await key('Enter');
  expect(JSON.parse(input().value.trim().slice(1))).toBe(`./${name}`);
  expect(projectMentionFormatter.parse(input().value)[0]).toEqual({ kind: 'mention', type: 'file', id: name, label: name });
  expect(sent).not.toHaveBeenCalled(); expect(inserted).toHaveBeenCalledOnce();
});
it('Backspace is never prevented: after a separator, after .., and at a root it deletes one character (D-299)', async () => {
  for (const query of ['@/', '@server/', '@../', '@./server/']) {
    await type(query); await tick();
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    await act(async () => { input().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(input().value).toBe(query);
  }
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
    await key('ArrowDown'); await key('Enter'); expect(input().value).toBe('@./next ');
    expect(sent).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key|unique.*key/u);
  } finally { errors.mockRestore(); }
});

// M16-T86. Choosing is the end of the question: the picker stops asking it.
it('a chosen file is finished — the picker never reopens, and the message sends the literal path', async () => {
  await type('@ser'); await tick(); await key('/'); await tick(); await key('Enter');
  expect(input().value).toBe('@./server/index.ts ');
  expect(listbox()).toBeNull();
  expect(await typeOn('and then some words')).toEqual([]);
  expect(input().value).toBe('@./server/index.ts and then some words');
  // The tag is presentation; the payload is the text the person can read.
  expect(tags().map(tag => [tag.dataset.mentionKind, tag.dataset.mentionLabel, tag.textContent])).toEqual([['file', 'server/index.ts', '@./server/index.ts']]);
  await act(async () => container.querySelector<HTMLElement>('button')!.click());
  await act(async () => { await Promise.resolve(); });
  expect(sent.mock.calls.at(-1)?.[0].content).toEqual([{ type: 'text', text: '@./server/index.ts and then some words' }]);
});

it('several mentions live in one message, and a fresh @ after a finished one opens the picker', async () => {
  await type('@ser'); await tick(); await key('Enter');
  expect(input().value).toBe('@./server/ ');
  expect(await typeOn('and ')).toEqual([]);
  // A fresh `@` is a fresh question — even for the same folder, which is the
  // case that tells the two tokens apart by where they were written.
  expect(await typeOn('@ser')).toHaveLength(4);
  await tick(); await key('Enter');
  expect(input().value).toBe('@./server/ and @./server/ ');
  expect(tags().map(tag => [tag.dataset.mentionKind, tag.textContent])).toEqual([['directory', '@./server/'], ['directory', '@./server/']]);
  expect(await typeOn('please')).toEqual([]);
});

it('editing inside a finished mention makes it a query again; deleting it leaves plain text', async () => {
  await type('@ser'); await tick(); await key('Enter'); await typeOn('now');
  expect(input().value).toBe('@./server/ now');
  expect(tags()).toHaveLength(1);
  // The caret goes back inside the path, and a character of it goes away.
  await type('@./sever/ now', 6);
  expect(listbox()).not.toBeNull();
  expect(tags()).toHaveLength(0);
  await tick();
  await type('now', 0);
  expect(listbox()).toBeNull();
  expect(tags()).toHaveLength(0);
});

it('a pasted message that already carries a path is finished, not an open query', async () => {
  const pasted = 'Look at @./server/index.ts and @./server/ too';
  await type(pasted);
  expect(listbox()).toBeNull();
  expect(tags().map(tag => [tag.dataset.mentionKind, tag.textContent])).toEqual([['file', '@./server/index.ts'], ['directory', '@./server/']]);
  expect(await typeOn(' please')).toEqual([]);
  expect(input().value).toBe(`${pasted} please`);
});

it('a handle in a draft that arrived whole is finished too, and typing one still asks', async () => {
  // A handle is never a chip in the transcript (D-284), so nothing in the text
  // says it was chosen: only the fact that the draft arrived whole does. A
  // person who picks `@audit`, reloads, and keeps typing must not be back in
  // the defect.
  await type('Ask @audit about @./server/index.ts today');
  expect(listbox()).toBeNull();
  expect(tags().map(tag => [tag.dataset.mentionKind, tag.textContent])).toEqual([['agent', '@audit'], ['file', '@./server/index.ts']]);
  expect(await typeOn(' please')).toEqual([]);
  // Typing a handle is still a question, and the list opens on it.
  expect((await typeOn(' @ser')).length).toBeGreaterThan(0);
  await tick();
  expect(options().length).toBeGreaterThan(0);
});

it('the tag layer follows a textarea that scrolls, on a composer that opened empty', async () => {
  // The listener has to be attached before the first tag exists: every
  // ordinary composer opens with an empty draft and gains one much later.
  await type('@ser'); await tick(); await key('Enter');
  expect(tags()).toHaveLength(1);
  const layer = container.querySelector<HTMLElement>('[data-slot="composer-mention-layer"]')!;
  let followed: number | undefined;
  Object.defineProperty(layer, 'scrollTop', { configurable: true, get: () => followed ?? 0, set: (value: number) => { followed = value; } });
  // Past `maxRows` the field scrolls and gives up part of its width to the
  // scrollbar; the mirror has to do both or the tags leave their words.
  Object.defineProperty(input(), 'scrollTop', { configurable: true, get: () => 42 });
  Object.defineProperty(input(), 'offsetWidth', { configurable: true, get: () => 320 });
  Object.defineProperty(input(), 'clientWidth', { configurable: true, get: () => 306 });
  await act(async () => { input().dispatchEvent(new Event('scroll')); });
  expect(followed).toBe(42);
  expect(layer.style.marginInlineEnd).toBe('14px');
});

it('More entries reads one next page while keeping the composer query', async () => {
  request.mockResolvedValueOnce({ path: '/project', home: '/home/test', entries: [], truncated: true, nextOffset: 80, commonPrefix: '' });
  await type('@'); await tick(); await key('Enter'); await tick();
  expect(input().value).toBe('@'); expect(request.mock.calls.at(-1)?.[1].explorer.offset).toBe(80);
  expect(inserted).not.toHaveBeenCalled();
});
