import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openInTextEditor, openSourceFile, textEditorSupported } from "../src/open-source-file.js";

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
  expect(await openInTextEditor('/project/a space;$(nothing).html',run,'linux')).toBe('');
  expect(run.mock.calls[0]?.slice(0,2)).toEqual(['xdg-mime',['query','default','text/plain']]);
  expect(run.mock.calls[1]?.slice(0,2)).toEqual(['gio',['launch',join(root,'applications','test-editor.desktop'),'file:///project/a%20space;$(nothing).html']]);
  expect(run.mock.calls.every(call => !call[2].shell)).toBe(true);
  run.mockReset().mockResolvedValue({stdout:'../../malicious.desktop'});
  expect(await openInTextEditor('/project/a.md',run,'linux')).not.toBe(''); expect(run).toHaveBeenCalledOnce();
});
it('opens the file in macOS\u2019s default text editor, never its own handler', async () => {
  const run = vi.fn().mockResolvedValue({stdout:''});
  expect(await openInTextEditor('/project/a space;$(nothing).html', run, 'darwin')).toBe('');
  expect(run.mock.calls[0]?.slice(0,2)).toEqual(['open',['-t','/project/a space;$(nothing).html']]);
  expect(run.mock.calls.every(call => !call[2].shell)).toBe(true);
  run.mockReset().mockRejectedValue(new Error('no editor'));
  expect(await openInTextEditor('/project/a.md', run, 'darwin')).not.toBe('');
});
it('opens the file with the text editor Windows registers for plain text, falling back to Notepad', async () => {
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  const notepad = 'C:\\Windows\\system32\\notepad.exe';
  const registry = (value: string) => vi.fn().mockResolvedValueOnce({stdout:`\r\nHKEY_CLASSES_ROOT\\txtfile\\shell\\open\\command\r\n    (Default)    REG_EXPAND_SZ    ${value}\r\n\r\n`}).mockResolvedValue({stdout:''});

  const expanded = registry('%SystemRoot%\\system32\\NOTEPAD.EXE %1');
  expect(await openInTextEditor('/project/a space;$(nothing).html', expanded, 'win32')).toBe('');
  expect(expanded.mock.calls[0]?.slice(0,2)).toEqual(['reg',['query','HKCR\\txtfile\\shell\\open\\command','/ve']]);
  expect(expanded.mock.calls[1]?.slice(0,2)).toEqual(['C:\\Windows\\system32\\NOTEPAD.EXE',['/project/a space;$(nothing).html']]);
  expect(expanded.mock.calls.every(call => !call[2].shell)).toBe(true);

  const quoted = registry('"C:\\Program Files\\Editor\\edit.exe" -n "%1"');
  expect(await openInTextEditor('C:\\project\\a.md', quoted, 'win32')).toBe('');
  expect(quoted.mock.calls[1]?.slice(0,2)).toEqual(['C:\\Program Files\\Editor\\edit.exe',['C:\\project\\a.md']]);

  const unquoted = registry('C:\\Program Files\\Editor\\edit.exe %1');
  await openInTextEditor('C:\\project\\a.md', unquoted, 'win32');
  expect(unquoted.mock.calls[1]?.[0]).toBe('C:\\Program Files\\Editor\\edit.exe');

  // A junk registration is never launched, and a missing one is not an error.
  const junk = registry('rundll32 shell32.dll,ShellExec_RunDLL %1');
  await openInTextEditor('C:\\project\\a.md', junk, 'win32');
  expect(junk.mock.calls[1]?.slice(0,2)).toEqual([notepad,['C:\\project\\a.md']]);
  const absent = vi.fn().mockRejectedValueOnce(new Error('reg missing')).mockResolvedValue({stdout:''});
  expect(await openInTextEditor('C:\\project\\a.md', absent, 'win32')).toBe('');
  expect(absent.mock.calls[1]?.slice(0,2)).toEqual([notepad,['C:\\project\\a.md']]);

  // A registered editor that will not start falls back rather than failing.
  const broken = vi.fn()
    .mockResolvedValueOnce({stdout:'    (Default)    REG_SZ    "C:\\Gone\\edit.exe" %1'})
    .mockRejectedValueOnce(new Error('ENOENT'))
    .mockResolvedValue({stdout:''});
  expect(await openInTextEditor('C:\\project\\a.md', broken, 'win32')).toBe('');
  expect(broken.mock.calls[2]?.slice(0,2)).toEqual([notepad,['C:\\project\\a.md']]);
  const dead = vi.fn().mockRejectedValue(new Error('ENOENT'));
  expect(await openInTextEditor('C:\\project\\a.md', dead, 'win32')).not.toBe('');
});
it('says where the feature exists, and never blames a missing editor on a platform it never tried', async () => {
  expect(['linux','darwin','win32'].every(platform => textEditorSupported(platform as NodeJS.Platform))).toBe(true);
  expect(textEditorSupported('freebsd')).toBe(false);
  const run = vi.fn();
  const reason = await openInTextEditor('/project/a.md', run, 'freebsd');
  expect(run).not.toHaveBeenCalled();
  expect(reason).not.toBe('');
  expect(reason).not.toMatch(/default text editor/i);
});
it('refuses URLs, relative paths, executables, missing files, directories and disguised symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-')); roots.push(root);
  const executable = join(root, 'run.desktop'); await writeFile(executable, 'not source');
  const alias = join(root, 'skill.md'); await symlink(executable, alias);
  const open = vi.fn();
  for (const path of ['https://example.com/a.md', 'relative.md', executable, alias, join(root, 'absent.md'), root, null]) expect((await openSourceFile(path, open)).opened).toBe(false);
  expect(open).not.toHaveBeenCalled();
});
