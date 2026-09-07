import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openSourceFile } from "../src/open-source-file.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('opens existing Markdown through the OS without interpreting path syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-')); roots.push(root);
  const path = join(root, 'a space;$(not-a-command).md'); await writeFile(path, '# Skill');
  const open = vi.fn().mockResolvedValue('');
  expect(await openSourceFile(path, open)).toEqual({ opened: true }); expect(open).toHaveBeenCalledWith(path);
  open.mockResolvedValue('No app'); expect((await openSourceFile(path, open)).opened).toBe(false);
});
it('refuses URLs, relative paths, executables, missing files, directories and disguised symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-file-')); roots.push(root);
  const executable = join(root, 'run.desktop'); await writeFile(executable, 'not source');
  const alias = join(root, 'skill.md'); await symlink(executable, alias);
  const open = vi.fn();
  for (const path of ['https://example.com/a.md', 'relative.md', executable, alias, join(root, 'absent.md'), root, null]) expect((await openSourceFile(path, open)).opened).toBe(false);
  expect(open).not.toHaveBeenCalled();
});
