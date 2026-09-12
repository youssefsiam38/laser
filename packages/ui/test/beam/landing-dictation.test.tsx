// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async original => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));
vi.mock("../../src/components/shell/shell-context.js", async original => ({
  ...(await original<typeof import("../../src/components/shell/shell-context.js")>()),
  useShell: () => ({ newSession: async () => {}, canCreate: true }),
}));
const audio = vi.hoisted(() => ({ push: undefined as ((chunk: Int16Array) => void) | undefined }));
vi.mock("../../src/pwa/phrase-dictation.js", async original => {
  const actual = await original<typeof import("../../src/pwa/phrase-dictation.js")>();
  return { ...actual, PhraseDictationAdapter: class extends actual.PhraseDictationAdapter {
    static override isSupported() { return true; }
    constructor(options: import("../../src/pwa/phrase-dictation.js").PhraseDictationOptions) {
      super({ ...options,
        getMedia: async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
        createCapture: async (_stream, push) => { audio.push = push; return { stop() {} }; },
      });
    }
  } };
});
vi.mock("../../src/pwa/environment.js", async original => ({
  ...(await original<typeof import("../../src/pwa/environment.js")>()),
  useEnvironment: () => ({ microphone: true }),
}));

import { Composer } from "../../src/components/thread/Composer.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { readDictationScope } from "../../src/pwa/mobile-dictation.js";
import { createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "./fake-host.js";

function PickProject() {
  const { setCurrentProject } = useLaserStable();
  useEffect(() => setCurrentProject(PROJECT_CWD), [setCurrentProject]);
  return null;
}
let world: World, root: Root, container: HTMLDivElement;
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); audio.push = undefined;
  world = createWorld();
  world.overrides["pi/transcribe/status"] = () => ({ available: true });
  world.overrides["pi/transcribe/begin"] = () => ({ id: "recording" });
  world.overrides["pi/transcribe/chunk"] = () => ({});
  world.overrides["pi/transcribe/end"] = () => ({ text: "Build a small clock" });
  FakeHostClient.reset(world);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LaserProvider url="ws://test"><TooltipProvider><PickProject /><Composer /></TooltipProvider></LaserProvider>));
  await act(async () => settle(80));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const calls = (method: string) => world.calls.filter(call => call.method === method);

it("records on the project landing and first Send waits for that phrase before creating and prompting", async () => {
  expect(calls("session/new")).toHaveLength(0);
  const mic = container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]');
  expect(mic).not.toBeNull();
  expect(readDictationScope()).toBeUndefined();
  await act(async () => mic!.click());
  await act(async () => settle(20));
  expect(readDictationScope()).toEqual({ cwd: PROJECT_CWD, path: undefined });
  await act(async () => audio.push!(new Int16Array(8_000).fill(5_000)));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  await act(async () => settle(100));
  expect(calls("pi/transcribe/begin")[0]?.params).toEqual({ cwd: PROJECT_CWD, mimeType: "audio/wav" });
  expect(calls("session/new")).toHaveLength(1);
  expect(calls("session/prompt")[0]?.params).toMatchObject({ content: [{ type: "text", text: "Build a small clock" }] });
});

it("puts a stopped phrase into the landing draft without creating a session", async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dictate a message"]')!.click());
  await act(async () => settle(20));
  await act(async () => audio.push!(new Int16Array(8_000).fill(5_000)));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation and transcribe"]')!.click());
  await act(async () => settle(30));
  expect(container.querySelector("textarea")!.value).toBe("Build a small clock");
  expect(calls("session/new")).toHaveLength(0);
});
