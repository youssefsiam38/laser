// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Each interaction mounts a real 240-message history, including its footers.
vi.setConfig({ testTimeout: 15_000 });

vi.mock("../../src/client.js", async (original) => {
  const { FakeWorkerClient } = await import("./fake-worker.js");
  const { historyWindow } = await import("@lasercode/protocol");
  return { ...(await original<typeof import("../../src/client.js")>()), HostClient: class extends FakeWorkerClient {
    override async request(method: string, params: unknown): Promise<unknown> {
      const result = await super.request(method, params);
      if (method !== "pi/session/entries") return result;
      const p = params as import("@lasercode/protocol").ClientRequests["pi/session/entries"]["params"];
      return historyWindow(result as { entries: unknown[]; leafId: string | null }, p.window!, {
        path: p.path, epoch: "fixture", seq: FakeWorkerClient.world.live[p.path]!.seq,
      });
    }
  } };
});
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p>{text}</p> }));

import { LaserProvider, useLaserStable, useLaserView, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { useHandedBackText } from "../../src/components/thread/Composer.js";
import { ThreadMessage } from "../../src/components/thread/messages.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { hasCompleteTree } from "../../src/runtime/history-loader.js";
import { addSession, createWorld, FakeWorkerClient, PROJECT_CWD, runTurn, settle, type World } from "./fake-worker.js";

const PATH = `${PROJECT_CWD}/history.jsonl`;
const prompt = "Review checkpoint 6: verify the implementation and explain the next step.";
let root: Root;
let container: HTMLDivElement;
let world: World;
let actions: LaserActions;
let view: ReturnType<typeof useLaserView>;
function Controls() {
  const stable = useLaserStable();
  actions = stable.actions;
  view = useLaserView();
  useHandedBackText();
  useEffect(() => { void stable.actions.openSession(PATH); }, [stable.actions]);
  return <button onClick={() => void actions.loadAllEntries()}>Load complete history</button>;
}
const flush = async () => { await act(async () => settle(30)); };
const click = async (button: Element) => { await act(async () => (button as HTMLElement).click()); await flush(); };
const button = (label: string, scope: ParentNode = container) => {
  const found = [...scope.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === label || b.textContent === label);
  expect(found, label).toBeDefined(); return found!;
};
const row = (text: string) => [...container.querySelectorAll('[data-role="user"]')].find(e => e.textContent?.includes(text))!;
const allReads = () => world.calls.filter(c => c.method === "pi/session/entries" && (c.params as { window?: { all?: boolean } }).window?.all);
const composer = () => container.querySelector<HTMLTextAreaElement>('[data-test="composer"]')!.value;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld(); addSession(world, PATH);
  for (let i = 1; i <= 120; i++) runTurn(world, PATH, `Review checkpoint ${i}: verify the implementation and explain the next step.`, `Checkpoint ${i} is complete.`);
  FakeWorkerClient.reset(world);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LaserProvider url="ws://test"><TooltipProvider><ThreadPrimitive.Root>
    <Controls /><ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
    <ComposerPrimitive.Root><ComposerPrimitive.Input data-test="composer" /></ComposerPrimitive.Root>
  </ThreadPrimitive.Root></TooltipProvider></LaserProvider>));
  await flush();
  expect(view?.blocks).toHaveLength(40);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("hands the exact older fork prompt to the destination composer, without a full-history read", async () => {
  await click(button("Load complete history"));
  expect(view?.blocks).toHaveLength(240);
  const count = allReads().length;
  const more = button("More", row(prompt));
  await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await flush();
  const fork = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent === "Fork from here");
  expect(fork).toBeDefined();
  await click(fork!);
  expect(view?.path).not.toBe(PATH);
  expect(view?.blocks).toHaveLength(10);
  expect(composer()).toBe(prompt);
  expect(allReads()).toHaveLength(count);
  // Returning to the source must not reveal the prompt in its old composer.
  await act(async () => actions.openSession(PATH)); await flush();
  expect(composer()).toBe("");
});

it("keeps known versions through Previous and Next, without a full-history read", async () => {
  await click(button("Load complete history"));
  const count = allReads().length;
  await click(button("Edit", row(prompt)));
  const input = row(prompt).querySelector("textarea")!;
  const edited = "Review checkpoint 9999: older-message edit";
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, edited);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Send", row(prompt)));
  await act(async () => actions.refreshEntries({ tail: true })); await flush();
  expect(hasCompleteTree(view)).toBe(true);
  await click(button("Previous version", row(edited)));
  expect(hasCompleteTree(view)).toBe(true);
  expect(button("Next version", row(prompt)).disabled).toBe(false);
  await click(button("Next version", row(prompt)));
  expect(row(edited)).toBeDefined();
  expect(hasCompleteTree(view)).toBe(true);
  expect(allReads()).toHaveLength(count);
});

it("numbers three versions in persisted tree order after earlier pages, metadata refresh and version switches", async () => {
  for (let size = 80; size <= 240; size += 40) {
    await act(async () => { await actions.loadEarlierEntries(); }); await flush();
    expect(view?.blocks).toHaveLength(size);
  }
  expect(allReads()).toHaveLength(0);
  const count = allReads().length;
  const edit = async (previous: string, next: string) => {
    await click(button("Edit", row(previous)));
    const input = row(previous).querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Send", row(previous)));
    await act(async () => actions.refreshEntries({ tail: true })); await flush();
  };
  await edit(prompt, "Second version");
  await edit("Second version", "Third version");
  const number = (text: string, index: number) => expect(row(text).querySelector(`[aria-label="Version ${index} of 3"]`)?.textContent).toBe(`${index} / 3`);
  number("Third version", 3);
  await click(button("Previous version", row("Third version")));
  number("Second version", 2);
  await click(button("Previous version", row("Second version")));
  number(prompt, 1);
  await click(button("Next version", row(prompt)));
  number("Second version", 2);
  await click(button("Next version", row("Second version")));
  number("Third version", 3);
  expect(allReads()).toHaveLength(count);
});

it("does not leave a handed-back draft after editing into a new session", async () => {
  await click(button("Load complete history"));
  await click(button("Edit", row(prompt)));
  await click(button("In a new session", row(prompt)));
  expect(view?.path).not.toBe(PATH);
  expect(view?.blocks.filter(b => b.kind === "user").at(-1)).toMatchObject({ text: prompt });
  expect(composer()).toBe("");
});
