import { afterEach, expect, it, vi } from "vitest";
import type { ProjectFileContent } from "@lasercode/protocol";
import { ProjectFileCache } from "../../src/runtime/project-file-cache.js";
const file = (path: string, content = "text"): ProjectFileContent => ({ path, content, name: path, size: content.length, mediaType: "text/plain", encoding: "utf8", modifiedAt: "", truncated: false });
afterEach(() => vi.useRealTimers());
it("deduplicates in-flight and retained reads, separates directories and expires old content", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (_cwd: string, path: string) => file(path));
  const cache = new ProjectFileCache(request);
  const one = cache.read("/a", "notes.md");
  expect(cache.read("/a", "notes.md")).toBe(one);
  await one;
  expect(cache.read("/a", "notes.md")).toBe(one);
  await cache.read("/b", "notes.md");
  expect(request).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(30_001);
  await cache.read("/a", "notes.md");
  expect(request).toHaveBeenCalledTimes(3);
});
it("evicts least-recent reads at eight entries and retries failures", async () => {
  const request = vi.fn(async (_cwd: string, path: string) => file(path));
  const cache = new ProjectFileCache(request);
  for (let i = 0; i < 8; i++) await cache.read("/p", `${i}`);
  await cache.read("/p", "0");
  await cache.read("/p", "8");
  await cache.read("/p", "0");
  expect(request).toHaveBeenCalledTimes(9);
  await cache.read("/p", "1");
  expect(request).toHaveBeenCalledTimes(10);
  request.mockRejectedValueOnce(new Error("Missing"));
  await expect(cache.read("/p", "new")).rejects.toThrow("Missing");
  await expect(cache.read("/p", "new")).resolves.toMatchObject({ path: "new" });
});
it("also bounds retained content, not just the number of files", async () => {
  const request = vi.fn(async (_cwd: string, path: string) => file(path, "x".repeat(9 * 1024 * 1024)));
  const cache = new ProjectFileCache(request);
  await cache.read("/p", "one");
  const two = cache.read("/p", "two"); await two;
  expect(cache.read("/p", "two")).toBe(two);
  await cache.read("/p", "one");
  expect(request).toHaveBeenCalledTimes(3);
});

/**
 * RP-8 step 1: this is the one renderer cache a pressure pass releases, so it
 * has to say exactly what it dropped — in the same unit every other renderer
 * counter uses — and it must never drop a read that is still in flight, which
 * holds nothing and would only cost a duplicate request.
 */
it("gives back what it holds, in exact bytes, and says nothing when it holds nothing", async () => {
  const request = vi.fn(async (_cwd: string, path: string) => file(path, "é".repeat(10)));
  const cache = new ProjectFileCache(request);
  expect(cache.clear()).toEqual({ count: 0, bytes: 0 });
  await cache.read("/p", "one");
  await cache.read("/p", "two");
  request.mockResolvedValueOnce(file("empty", ""));
  await cache.read("/p", "empty");
  // Two files of ten two-byte characters each plus one empty retained entry.
  expect(cache.clear()).toEqual({ count: 3, bytes: 40 });
  expect(cache.clear()).toEqual({ count: 0, bytes: 0 });
  await cache.read("/p", "one");
  expect(request).toHaveBeenCalledTimes(4);
});

it("leaves a read still in flight alone", async () => {
  let settle: ((value: ProjectFileContent) => void) | undefined;
  const request = vi.fn(() => new Promise<ProjectFileContent>((resolve) => { settle = resolve; }));
  const cache = new ProjectFileCache(request);
  const reading = cache.read("/p", "slow");
  expect(cache.clear()).toEqual({ count: 0, bytes: 0 });
  settle!(file("slow", "abc"));
  await expect(reading).resolves.toMatchObject({ path: "slow" });
  expect(cache.clear()).toEqual({ count: 1, bytes: 3 });
});
