// @vitest-environment happy-dom
/**
 * M16-T32: a streamed token touches the row it is streaming into.
 *
 * Both cases are the real seam, not a stub: the real external-store runtime,
 * the real bounded window and the real find hook. Each fails on the behaviour
 * the browser profile found — settled rows re-rendered with the window, and
 * the find hook held a subscription to every message while it was closed, so
 * the thread column re-rendered on every streamed batch.
 */
import { act, memo } from "react";
import { type ThreadMessageLike, useAuiState } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConversationFind } from "../../src/components/thread/use-conversation-find.js";
import { useThreadToolTimeline } from "../../src/components/assistant-ui/elements/tool-timeline.js";
import { useSessionFileChanges } from "../../src/components/assistant-ui/elements/file-tree.js";
import { mountRig, type Rig } from "./virtual-rig.js";

const renders = new Map<string, number>();
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  return {
    ThreadMessage: function Message() {
      const id = useAuiState(s => s.message.id);
      const text = useAuiState(s => s.message.parts.map(part => (part.type === "text" ? part.text : "")).join(""));
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return <p>{text}</p>;
    },
  };
});

let rig: Rig | undefined;
let host: HTMLElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  renders.clear();
});
afterEach(async () => { await rig?.dispose(); rig = undefined; vi.restoreAllMocks(); });
const settled = (count: number): ThreadMessageLike[] =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, role: index % 2 ? "assistant" : "user", content: `Row ${index} of the transcript` }));

let findRenders = 0;
let selectedMessage: string | undefined;
/**
 * Memoised, and its props never change: it re-renders only when something it
 * subscribes to changes. That is what makes the closed-bar count meaningful —
 * the fixture around it re-renders for every delta, this does not have to.
 */
const FindProbe = memo(function FindProbe() {
  findRenders++;
  const find = useConversationFind({});
  selectedMessage = find.selectedMessage;
  return <div ref={find.root} />;
});

let monitorRenders = 0;
let monitorSteps = 0;
let monitorFiles = 0;
/** The monitor's two message-derived sections, memoised like the real column. */
const MonitorProbe = memo(function MonitorProbe() {
  monitorRenders++;
  monitorSteps = useThreadToolTimeline().steps.length;
  monitorFiles = useSessionFileChanges().length;
  return null;
});

/**
 * The transcript over the rig's browser (M16-T87): the row the turn streams
 * into is the newest one, so it is only mounted at all when the surface is a
 * real scroller holding the live edge.
 */
let live = "Reviewing";
let tool: ThreadMessageLike | undefined;
async function mount(count: number, extras?: React.ReactNode) {
  const ids = [...settled(count).map(message => message.id as string), "live"];
  const started = await mountRig({
    ids,
    height: () => 100,
    clientHeight: 700,
    ...(extras !== undefined ? { extras } : {}),
    running: true,
    messages: () => [...settled(count), ...(tool ? [tool] : []), { id: "live", role: "assistant", content: live, status: { type: "running" } }],
  });
  host = started.container;
  return started;
}

const frames = async (count = 3) => {
  for (let frame = 0; frame < count; frame++) await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
};

it("re-renders the streaming row and no settled row for each delta", async () => {
  live = "Reviewing"; tool = undefined;
  rig = await mount(12);
  const render = async (next: string) => { live = next; await rig!.render([...settled(12).map(message => message.id as string), "live"]); };
  await frames();
  const mounted = [...host.querySelectorAll("[data-window-message]")].map(row => row.getAttribute("data-window-message")!);
  expect(mounted).toContain("live");
  expect(mounted.length).toBeGreaterThan(1);
  const before = new Map(renders);

  let text = "Reviewing";
  for (let delta = 0; delta < 8; delta++) {
    text += ` step ${delta},`;
    await render(text);
  }
  await frames();

  for (const id of mounted) {
    if (id === "live") continue;
    expect(`${id}: ${renders.get(id) ?? 0}`).toBe(`${id}: ${before.get(id) ?? 0}`);
  }
  expect(renders.get("live")).toBeGreaterThan(before.get("live")!);
  expect(host.querySelector('[data-window-message="live"]')?.textContent).toBe(live);
});

it("leaves the monitor's tool and file sections still through a reply, and moves them for a tool call", async () => {
  live = "Reviewing"; tool = undefined;
  rig = await mount(4, <MonitorProbe />);
  const render = async (next: string, call?: ThreadMessageLike) => {
    live = next; tool = call;
    await rig!.render([...settled(4).map(message => message.id as string), ...(call ? ["tool"] : []), "live"]);
  };
  await render("Reviewing");
  await frames();
  const before = monitorRenders;

  let text = "Reviewing";
  for (let delta = 0; delta < 8; delta++) { text += ` step ${delta},`; await render(text); }
  await frames();
  expect(monitorRenders).toBe(before);
  expect(monitorSteps).toBe(0);

  const call: ThreadMessageLike = { id: "tool", role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "write", args: { path: "src/app.ts" }, argsText: '{"path":"src/app.ts"}', status: { type: "running" } }] };
  await render(text, call);
  await frames();
  expect(monitorRenders).toBeGreaterThan(before);
  expect(monitorSteps).toBe(1);
  expect(monitorFiles).toBe(0);
});

it("holds no transcript subscription while find is closed, and reads the live transcript once it is open", async () => {
  live = "Reviewing"; tool = undefined;
  rig = await mount(4, <FindProbe />);
  // The find bar only opens for a thread that is actually on screen; the
  // probe's own root is not a transcript row, so it needs a box of its own.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 600, 40)] as unknown as DOMRectList);
  const render = async (next: string) => { live = next; await rig!.render([...settled(4).map(message => message.id as string), "live"]); };
  await frames();

  const closedRenders = findRenders;
  let text = "Reviewing";
  for (let delta = 0; delta < 6; delta++) { text += ` step ${delta},`; await render(text); }
  await frames();
  // Six deltas through the real runtime, and the closed bar did not wake once.
  expect(findRenders).toBe(closedRenders);

  await act(async () => { window.dispatchEvent(new CustomEvent("conversation-find", { detail: { query: "step 5" } })); });
  await frames();
  expect(selectedMessage).toBe("live");
});
