// @vitest-environment happy-dom
/**
 * RP-5b §2: the surface that shows the rest of a prompt's files.
 *
 * One page is held; moving on discards the page before it; closing discards
 * everything; a reply that lands after any of that is not shown. Focus comes
 * back to what opened it.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AttachmentBrowser } from "../../src/components/thread/AttachmentBrowser.js";
import { LaserStoreProvider, createStateStore } from "../../src/runtime/LaserProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { initialState } from "../../src/store.js";

const SESSION = "/project/session.jsonl";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const TOTAL = 500_000;

const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: { listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn() },
}));
vi.mock("@/runtime", async original => ({
  ...await original<typeof import("../../src/runtime/index.js")>(),
  useLaserStable: () => stable,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  stable.client.request.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const body = {
  entryId: "u1", component: { kind: "user_text" as const }, totalBytes: TOTAL, revision: "r1.env.2",
  contentDigest: sha("whole"), excerpt: { offset: 0, bytes: 0 },
};
const item = (offset: number, name: string) => ({ offset, bytes: 10, name, mediaType: "text/plain", contentDigest: sha(name) });
const page = (items: ReturnType<typeof item>[], over: Record<string, unknown> = {}) => ({
  authority: "durable", revision: "r1.env.2", component: { kind: "user_text" }, totalBytes: TOTAL, items, scannedBytes: TOTAL, ...over,
});

function mount(node: React.ReactNode) {
  const store = createStateStore(initialState);
  act(() => root.render(<LaserStoreProvider store={store}><TooltipProvider>{node}</TooltipProvider></LaserStoreProvider>));
}

const rows = () => [...document.querySelectorAll('[data-slot="attachment-browser-item"]')].map(node => node.textContent ?? "");
const nextButton = () => [...document.querySelectorAll("button")].find(node => /Next|Reading…/.test(node.textContent ?? ""));

describe("the attachment browser", () => {
  it("shows one page, and the next page replaces it instead of adding to it", async () => {
    stable.client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "session/revision") return { revision: "r1.env.2", environmentKey: "env" };
      if (method !== "session/entry_regions") return {};
      return ((params.from as number | undefined) ?? 0) === 0
        ? page([item(10, "a.txt"), item(40, "b.txt")], { next: 90, omitted: 3 })
        : page([item(90, "c.txt")], { omitted: 2 });
    });
    mount(<AttachmentBrowser body={body} path={SESSION} open onOpenChange={() => {}} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(rows().map(text => text.slice(0, 5))).toEqual(["a.txt", "b.txt"]);
    // The exact count the authority gave.
    expect(document.body.textContent).toContain("3 more attachments in this message");

    await act(async () => { nextButton()!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    // Replaced, not accumulated.
    expect(rows().map(text => text.slice(0, 5))).toEqual(["c.txt"]);
    const asked = stable.client.request.mock.calls.filter(call => call[0] === "session/entry_regions").map(call => (call[1] as { from?: number }).from);
    expect(asked).toEqual([undefined, 90]);
  });

  it("says 'More attachments' with no number when the authority could not see the whole message", async () => {
    stable.client.request.mockImplementation(async (method: string) => {
      if (method === "session/revision") return { revision: "r1.env.2", environmentKey: "env" };
      return method === "session/entry_regions" ? page([item(10, "a.txt")], { truncated: true }) : {};
    });
    mount(<AttachmentBrowser body={body} path={SESSION} open onOpenChange={() => {}} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(document.body.textContent).toContain("More attachments in this message");
    expect(document.body.textContent).not.toMatch(/\d+ more attachment/);
  });

  it("drops a page that arrives after it was closed", async () => {
    let release: ((value: unknown) => void) | undefined;
    stable.client.request.mockImplementation(async (method: string) => {
      if (method === "session/revision") return { revision: "r1.env.2", environmentKey: "env" };
      if (method !== "session/entry_regions") return {};
      return new Promise(resolve => { release = resolve; });
    });
    mount(<AttachmentBrowser body={body} path={SESSION} open onOpenChange={() => {}} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // It closes while the read is in flight.
    mount(<AttachmentBrowser body={body} path={SESSION} open={false} onOpenChange={() => {}} />);
    await act(async () => { release!(page([item(10, "late.txt")])); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(document.body.textContent).not.toContain("late.txt");
    expect(rows()).toEqual([]);
  });

  it("refuses a page that is not about this body, and offers to try again", async () => {
    stable.client.request.mockImplementation(async (method: string) => {
      if (method === "session/revision") return { revision: "r1.env.2", environmentKey: "env" };
      return method === "session/entry_regions" ? page([item(10, "a.txt")], { revision: "r9.env.2" }) : {};
    });
    mount(<AttachmentBrowser body={body} path={SESSION} open onOpenChange={() => {}} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(rows()).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent ?? "").toMatch(/\w/);
  });

  it("closes on Escape and asks its owner to close, so focus can return to the trigger", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    stable.client.request.mockImplementation(async (method: string) => {
      if (method === "session/revision") return { revision: "r1.env.2", environmentKey: "env" };
      return method === "session/entry_regions" ? page([item(10, "a.txt")]) : {};
    });
    let closes = 0;
    function Host() {
      const [open, setOpen] = useState(true);
      return <AttachmentBrowser body={body} path={SESSION} open={open} onOpenChange={value => { if (!value) closes += 1; setOpen(value); }} returnFocus={trigger} />;
    }
    mount(<Host />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // Escape, the way a person closes it from the keyboard.
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
    // It really closed, and told its owner so; where focus lands is proved in
    // a real browser by the harness, not by a DOM stand-in.
    expect(rows()).toEqual([]);
    expect(closes).toBeGreaterThan(0);
    expect(document.querySelector('[data-slot="attachment-browser-list"]')).toBeNull();
    trigger.remove();
  });
});
