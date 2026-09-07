// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProjectFileSearch } from "../../src/components/thread/use-project-file-search.js";

const request = vi.hoisted(() => vi.fn());
const client = { request };
vi.mock('@/runtime', () => ({ useLaserStable: () => ({ client }) }));
let root: Root, container: HTMLDivElement;
function Harness({ cwd = '/project', query = '', active = true }: { cwd?: string; query?: string; active?: boolean }) {
  const search = useProjectFileSearch(cwd, query, active);
  return <div>{search.loading ? 'Loading' : search.failed ? 'Failed' : search.files.map(file => file.path).join(',')}{search.truncated && ' · More results'}<button onClick={search.retry}>Retry</button></div>;
}
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); request.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const result = (path: string) => ({ cwd: '/project', files: [{ path, name: path, tracked: true }], source: 'git', truncated: false });
const render = async (query: string, cwd = '/project') => { await act(async () => root.render(<Harness query={query} cwd={cwd} />)); };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(150); }); };

it('sends each debounced query to the project index, including files outside the first page', async () => {
  request.mockResolvedValue(result('deep/file-9999.ts'));
  await render('d'); await render('deep'); expect(request).not.toHaveBeenCalled();
  await tick(); expect(request).toHaveBeenCalledExactlyOnceWith('pi/project/files', { cwd: '/project', query: 'deep', limit: 80 });
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
it('reports a failure, supports retry and exposes truncated results honestly', async () => {
  request.mockRejectedValueOnce(new Error('private path and stack'));
  await render('x'); await tick(); expect(container.textContent).toContain('Failed'); expect(container.textContent).not.toContain('private');
  request.mockResolvedValue({ ...result('x.ts'), truncated: true });
  await act(async () => container.querySelector('button')!.click()); await tick();
  expect(container.textContent).toContain('x.ts · More results');
});
it('does not query a closed picker and refreshes when reopened', async () => {
  request.mockResolvedValue(result('new.ts'));
  await act(async () => root.render(<Harness active={false} />)); await tick(); expect(request).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness active />)); await tick(); expect(request).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Harness active={false} />));
  await act(async () => root.render(<Harness active />)); await tick(); expect(request).toHaveBeenCalledTimes(2);
});
