import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
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
it('prefers exact filenames to scattered matches and accepts native path separators', () => {
  expect(scoreMatch('src/review.ts', 'review.ts')).toBeGreaterThan(scoreMatch('review/another.ts', 'review.ts')!);
  expect(scoreMatch('src/components/Input.tsx', 'src\\Input')).toBeDefined();
});
