import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openInTextEditor, openSourceFile } from "../src/open-source-file.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('opens existing Markdown through the OS without interpreting path syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-')); roots.push(root);
  const path = join(root, 'a space;$(not-a-command).md'); await writeFile(path, '# Skill');
  const open = vi.fn().mockResolvedValue('');
  expect(await openSourceFile(path, open)).toEqual({ opened: true }); expect(open).toHaveBeenCalledWith(path);
  open.mockResolvedValue('No app'); expect((await openSourceFile(path, open)).opened).toBe(false);
});
it('opens code, HTML and scripts as text, and refuses binary content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-')); roots.push(root);
  const open = vi.fn().mockResolvedValue('');
  for (const name of ['index.ts', 'index.html', 'run.sh', 'Dockerfile']) {
    const path = join(root, name); await writeFile(path, 'plain source');
    expect(await openSourceFile(path, open)).toEqual({ opened: true });
  }
  const binary = join(root, 'fake.md'); await writeFile(binary, Buffer.from([127,69,76,70,0]));
  open.mockClear(); expect((await openSourceFile(binary, open)).opened).toBe(false); expect(open).not.toHaveBeenCalled();
});
it('selects the default TEXT editor and passes the file as data, never its MIME handler or a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-editor-')); roots.push(root);
  await mkdir(join(root,'applications')); await writeFile(join(root,'applications','test-editor.desktop'), '[Desktop Entry]');
  vi.stubEnv('XDG_DATA_HOME', root);
  const run = vi.fn().mockResolvedValueOnce({stdout:'test-editor.desktop\n'}).mockResolvedValue({stdout:''});
  expect(await openInTextEditor('/project/a space;$(nothing).html',run)).toBe('');
  expect(run.mock.calls[0]?.slice(0,2)).toEqual(['xdg-mime',['query','default','text/plain']]);
  expect(run.mock.calls[1]?.slice(0,2)).toEqual(['gio',['launch',join(root,'applications','test-editor.desktop'),'file:///project/a%20space;$(nothing).html']]);
  expect(run.mock.calls.every(call => !call[2].shell)).toBe(true);
  run.mockReset().mockResolvedValue({stdout:'../../malicious.desktop'});
  expect(await openInTextEditor('/project/a.md',run)).not.toBe(''); expect(run).toHaveBeenCalledOnce();
});
it('refuses URLs, relative paths, executables, missing files, directories and disguised symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-')); roots.push(root);
  const executable = join(root, 'run.desktop'); await writeFile(executable, 'not source');
  const alias = join(root, 'skill.md'); await symlink(executable, alias);
  const open = vi.fn();
  for (const path of ['https://example.com/a.md', 'relative.md', executable, alias, join(root, 'absent.md'), root, null]) expect((await openSourceFile(path, open)).opened).toBe(false);
  expect(open).not.toHaveBeenCalled();
});
