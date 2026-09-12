import { afterEach, expect, it, vi } from "vitest";
import { transcriptionAvailable } from "../../src/pwa/transcription-availability.js";

afterEach(() => vi.useRealTimers());

it("deduplicates concurrent directory checks and isolates hosts and directories", async () => {
  const client = { request: vi.fn().mockResolvedValue({ available: true }) };
  const first = transcriptionAvailable(client, "/fresh");
  expect(transcriptionAvailable(client, "/fresh")).toBe(first);
  await expect(first).resolves.toBe(true);
  await transcriptionAvailable(client, "/another");
  expect(client.request.mock.calls).toEqual([
    ["pi/transcribe/status", { cwd: "/fresh" }],
    ["pi/transcribe/status", { cwd: "/another" }],
  ]);
  const otherHost = { request: vi.fn().mockResolvedValue({ available: false }) };
  await expect(transcriptionAvailable(otherHost, "/fresh")).resolves.toBe(false);
});

it("keeps discovery failures quiet and retryable, and expires credential availability", async () => {
  vi.useFakeTimers();
  const client = { request: vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ available: true }) };
  await expect(transcriptionAvailable(client, "/fresh")).resolves.toBe(false);
  await expect(transcriptionAvailable(client, "/fresh")).resolves.toBe(true);
  expect(client.request).toHaveBeenCalledTimes(2);
  client.request.mockResolvedValue({ available: false });
  await vi.advanceTimersByTimeAsync(30_001);
  await expect(transcriptionAvailable(client, "/fresh")).resolves.toBe(false);
  expect(client.request).toHaveBeenCalledTimes(3);
});
