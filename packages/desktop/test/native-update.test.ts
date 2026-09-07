import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeUpdateWatch, installedHostVersion } from "../src/native-update.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); vi.useRealTimers(); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "native-update-test-")); roots.push(root); return root;
};
it("announces only a completed changed install and never decides to restart", () => {
  const root = fixture(), ready = vi.fn();
  const watch = new NativeUpdateWatch({ resources: root, running: "1.0.0", onReady: ready });
  const marker = join(root, "native-update.json");
  expect(watch.check()).toBeUndefined();
  writeFileSync(marker, '{"version":"1.0.0"}'); expect(watch.check()).toBeUndefined();
  writeFileSync(marker, '{"version":'); expect(watch.check()).toBeUndefined();
  writeFileSync(marker, '{"version":"1.0.1"}');
  expect(watch.check()).toBe("1.0.1"); expect(watch.check()).toBe("1.0.1");
  expect(ready).toHaveBeenCalledExactlyOnceWith("1.0.1");
});
it("polling stops on exit and a subsequent installed version is announced once", () => {
  vi.useFakeTimers();
  const root = fixture(), ready = vi.fn();
  const watch = new NativeUpdateWatch({ resources: root, running: "1.0.0", onReady: ready });
  watch.start(); writeFileSync(join(root, "native-update.json"), '{"version":"1.0.1"}');
  vi.advanceTimersByTime(30_000); expect(ready).toHaveBeenCalledTimes(1);
  watch.stop(); writeFileSync(join(root, "native-update.json"), '{"version":"1.0.2"}');
  vi.advanceTimersByTime(60_000); expect(ready).toHaveBeenCalledTimes(1);
  watch.check(); expect(ready).toHaveBeenLastCalledWith("1.0.2");
});
it("reads installed host files uncached so an old supervisor cannot spawn a newer daemon", () => {
  const root = fixture(), dir = join(root, "app.asar.unpacked/node_modules/@lasercode/cli");
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "package.json");
  writeFileSync(manifest, '{"version":"1.0.0"}'); expect(installedHostVersion(root)).toBe("1.0.0");
  writeFileSync(manifest, '{"version":"1.0.1"}'); expect(installedHostVersion(root)).toBe("1.0.1");
});
