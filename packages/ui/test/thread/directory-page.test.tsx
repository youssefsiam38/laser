// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDirectoryPage } from "../../src/components/thread/use-directory-page.js";

// The explorer's reply validator is a chunk of its own (M16-T31), asked for
// beside the first listing request. These tests drive fake timers, which cannot
// advance a module load, so it is here once instead of mid-assertion; the cold
// path — nothing fetched until `@` — is proved in the browser check.
await import("../../src/components/thread/explorer-listing.js");

const request = vi.hoisted(() => vi.fn());
const client = { request };
vi.mock('@/runtime', () => ({ useLaserStable: () => ({ client }) }));
let root: Root, container: HTMLDivElement;
function Harness({ cwd = '/project', query = '', active = true }: { cwd?: string; query?: string; active?: boolean }) {
  const page = useDirectoryPage(cwd, query, active);
  return <div>{page.loading ? 'Loading' : page.issue ? page.issue.kind : page.entries.map(entry => entry.path).join(',')}{page.retry && <button onClick={page.retry}>Retry</button>}{page.navigation.next && <button onClick={page.navigation.next}>More</button>}</div>;
}
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); request.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const result = (path: string) => ({ path: '/project', home: '/home/test', entries: [{ path, name: path, kind: 'file', project: false }], truncated: false, commonPrefix: '' });
const render = async (query: string, cwd = '/project') => { await act(async () => root.render(<Harness query={query} cwd={cwd} />)); };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(150); }); };

it.each(['C:relative', 'server/ '])('reports a local refusal without a dead retry or request: %s', async query => {
  await render(query); await tick();
  expect(container.textContent).toBe('refusal'); expect(request).not.toHaveBeenCalled(); expect(container.querySelector('button')).toBeNull();
});
it('reports a host read failure and retries successfully', async () => {
  request.mockResolvedValueOnce({ ...result(''), entries: [], error: 'You do not have permission to open this folder.' });
  await render(''); await tick(); expect(container.textContent).toBe('failureRetry');
  request.mockResolvedValueOnce(result('ready.ts'));
  await act(async () => container.querySelector('button')!.click()); await tick();
  expect(container.textContent).toBe('ready.ts'); expect(request).toHaveBeenCalledTimes(2);
});
it('refuses untyped legacy entries at the explorer response boundary, then permits a valid retry', async () => {
  request.mockResolvedValueOnce({ ...result('folder'), entries: [{ path: '/project/folder', name: 'folder', project: false }] });
  await render(''); await tick(); expect(container.textContent).toBe('failureRetry');
  request.mockResolvedValueOnce(result('valid.ts'));
  await act(async () => container.querySelector('button')!.click()); await tick(); expect(container.textContent).toBe('valid.ts');
});

it('sends the debounced directory and prefix to host browse', async () => {
  request.mockResolvedValue(result('deep/file-9999.ts'));
  await render('d'); await render('deep'); expect(request).not.toHaveBeenCalled();
  await tick(); expect(request).toHaveBeenCalledExactlyOnceWith('pi/project/browse', { path: '.', explorer: { mode: 'explorer', cwd: '/project', prefix: 'deep', offset: 0, limit: 80 } });
  expect(container.textContent).toContain('deep/file-9999.ts');
});
it('ignores stale replies after query and project changes and never shows the old files as current', async () => {
  let old!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(resolve => { old = resolve; }));
  await render('old'); await tick();
  request.mockResolvedValue(result('new.ts'));
  await render('new', '/other'); expect(container.textContent).toContain('Loading'); await tick();
  await act(async () => old(result('old.ts')));
  expect(container.textContent).toContain('new.ts'); expect(container.textContent).not.toContain('old.ts');
});
it('accepts home and env spellings for host-side resolution', async () => {
  request.mockResolvedValue(result('/home/test/ready.ts'));
  for (const query of ['~', '~/', '%USERPROFILE%', '%USERPROFILE%\\']) {
    request.mockClear(); await render(query); await tick();
    expect(request.mock.calls[0]?.[1].path).toMatch(/^(~|%USERPROFILE%)$/u);
  }
});
it('reports a transport failure and supports successful retry', async () => {
  request.mockRejectedValueOnce(new Error('private path and stack'));
  await render('x'); await tick(); expect(container.textContent).toContain('failure'); expect(container.textContent).not.toContain('private');
  request.mockResolvedValue({ ...result('x.ts'), truncated: true });
  await act(async () => container.querySelector('button')!.click()); await tick();
  expect(container.textContent).toContain('x.ts'); expect(container.textContent).not.toContain('Retry');
});
it('starts at the first page after navigating away and back', async () => {
  request.mockResolvedValue({ ...result('x.ts'), truncated: true, nextOffset: 80 });
  await render('x'); await tick();
  await act(async () => container.querySelector('button')!.click()); await tick();
  expect(request.mock.calls.at(-1)?.[1].explorer.offset).toBe(80);
  await render('server/'); await tick(); await render('x'); await tick();
  expect(request.mock.calls.at(-1)?.[1].explorer.offset).toBe(0);
});
it('does not query a closed picker and refreshes when reopened', async () => {
  request.mockResolvedValue(result('new.ts'));
  await act(async () => root.render(<Harness active={false} />)); await tick(); expect(request).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness active />)); await tick(); expect(request).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Harness active={false} />));
  await act(async () => root.render(<Harness active />)); await tick(); expect(request).toHaveBeenCalledTimes(2);
});
