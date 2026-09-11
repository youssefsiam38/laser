import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectFilesService, scoreMatch } from "../src/files.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('searches beyond the initial page, honors ignore rules and omits deleted tracked files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'file-picker-')); roots.push(cwd);
  execFileSync('git', ['init', '--quiet'], { cwd });
  await writeFile(join(cwd, '.gitignore'), 'ignored/\n');
  await writeFile(join(cwd, 'deleted.ts'), '');
  execFileSync('git', ['add', 'deleted.ts'], { cwd }); await rm(join(cwd, 'deleted.ts'));
  await mkdir(join(cwd, 'ignored')); await writeFile(join(cwd, 'ignored/secret.ts'), '');
  await Promise.all(Array.from({ length: 600 }, (_, index) => writeFile(join(cwd, `file-${String(index).padStart(4, '0')}.ts`), '')));
  const service = new ProjectFilesService({ cwd });
  const first = await service.list({ limit: 80 }); expect(first.files).toHaveLength(80); expect(first.truncated).toBe(true);
  const found = await service.list({ query: 'file-0599', limit: 80 }); expect(found.files.map(file => file.path)).toEqual(['file-0599.ts']);
  expect((await service.list({ query: 'secret' })).files).toEqual([]);
  expect((await service.list({ query: 'deleted' })).files).toEqual([]);
});
it('reads relative and absolute project files with metadata', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'file-read-')); roots.push(cwd);
  await writeFile(join(cwd, 'document.md'), '# Document\n');
  const service = new ProjectFilesService({ cwd });
  const result = await service.read('document.md');
  expect(result).toMatchObject({ path: 'document.md', name: 'document.md', mediaType: 'text/markdown', encoding: 'utf8', content: '# Document\n', size: 11, truncated: false });
  expect(Number.isNaN(Date.parse(result.modifiedAt))).toBe(false);
  expect(await service.read(join(cwd, 'document.md'))).toEqual(result);
});
it('refuses traversal, escaping symlinks, directories and special files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'file-read-')); roots.push(base);
  const cwd = join(base, 'project'); await mkdir(cwd);
  await writeFile(join(base, 'secret.txt'), 'secret');
  await symlink(join(base, 'secret.txt'), join(cwd, 'escape.txt'));
  const service = new ProjectFilesService({ cwd });
  for (const path of ['../secret.txt', join(base, 'secret.txt'), 'escape.txt']) {
    await expect(service.read(path)).rejects.toThrow('That file is outside this project.');
  }
  await expect(service.read('.')).rejects.toThrow('not a regular file');
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [join(cwd, 'pipe')]);
    await expect(service.read('pipe')).rejects.toThrow('not a regular file');
  }
  await expect(service.read('gone.txt')).rejects.toThrow('That file could not be found. It may have been moved or deleted.');
});
it('caps UTF-8 at 2 MiB without a partial character and images at 12 MiB', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'file-read-')); roots.push(cwd);
  const service = new ProjectFilesService({ cwd });
  await writeFile(join(cwd, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 - 1) + 'é');
  const text = await service.read('large.txt');
  expect(text.truncated).toBe(true);
  expect(text.content).toBe('x'.repeat(2 * 1024 * 1024 - 1));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(join(cwd, 'image.png'), png);
  expect(await service.read('image.png')).toMatchObject({ mediaType: 'image/png', encoding: 'base64', content: png.toString('base64'), truncated: false });
  await writeFile(join(cwd, 'large.png'), Buffer.alloc(12 * 1024 * 1024 + 1, 1));
  const image = await service.read('large.png');
  expect(image.truncated).toBe(true);
  expect(Buffer.from(image.content, 'base64').length).toBe(12 * 1024 * 1024);
});

it('prefers exact filenames to scattered matches and accepts native path separators', () => {
  expect(scoreMatch('src/review.ts', 'review.ts')).toBeGreaterThan(scoreMatch('review/another.ts', 'review.ts')!);
  expect(scoreMatch('src/components/Input.tsx', 'src\\Input')).toBeDefined();
});
