// @vitest-environment happy-dom
/**
 * The API request inspector over a session that keeps working (M16-T35).
 *
 * The dialog is mounted from a live transcript row, so its props move while a
 * turn streams and when the settled turn's entries are re-read. None of that
 * is a person asking for another capture, and the browser check
 * `scripts/browser-check/test/api-request-flicker.mjs` watches the same thing
 * against a real host. These pin the component's side of it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogEntry } from "@lasercode/protocol";
import { ApiRequestDialog as Inspector } from "../../src/components/logs/ApiRequestDialog.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { ComponentProps, ReactNode } from "react";

function ApiRequestDialog(props: ComponentProps<typeof Inspector>) { return <TooltipProvider><Inspector {...props}/></TooltipProvider>; }

const client = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client }) }));

const capture = (id: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  id, at: `2026-09-06T10:0${id}:00.000Z`, section: "provider", kind: "provider_request", level: "info",
  summary: "test-model", sessionPath: "/session",
  requestContext: { promptEntryId: "user-1", provider: "openai", model: "test-model" },
  detail: { instructions: `Capture ${id} instructions`, input: [{ role: "user", content: "hello" }] },
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
let offered: LogEntry[];
let queries: unknown[];
let contents: unknown[];
let held: ((entries: LogEntry[]) => void) | undefined;
let hold = false;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  queries = []; contents = []; offered = [capture(1)]; held = undefined; hold = false;
  client.request.mockReset();
  client.request.mockImplementation(async (method: string, params: unknown) => {
    if (method === "pi/logs/query") {
      queries.push(params);
      if (hold) return new Promise<{ entries: LogEntry[]; hasMore: boolean }>((resolve) => { held = (entries) => resolve({ entries, hasMore: false }); });
      return { entries: offered, hasMore: false };
    }
    if (method === "pi/logs/content") { contents.push(params); return { text: JSON.stringify({ instructions: "Referenced capture instructions" }), truncated: false }; }
    if (method === "pi/prefs/get") return { entries: [] };
    return {};
  });
  client.subscribe.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

/** The body is a lazy chunk behind the frame: render, then let Suspense resolve. */
const mount = async (element: ReactNode) => {
  await act(async () => root.render(element));
  await act(async () => { await import("../../src/components/logs/ApiRequestDialogBody.js"); });
};
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const picker = () => document.querySelector<HTMLSelectElement>('select[aria-label="Captured request"]')!;
const loaders = () => document.querySelectorAll('[data-slot="generation-loader"]').length;
const refresh = async () => { await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Refresh captured requests"]')!.click()); };

const live = (entryId: string | undefined, beforeAt?: string): ComponentProps<typeof Inspector>["target"] => ({
  kind: "message", path: "/session", ...(entryId ? { entryId } : {}), at: "2026-09-06T10:00:00.000Z", ...(beforeAt ? { beforeAt } : {}),
});

it("keeps the capture it was opened on while the transcript moves under it", async () => {
  await mount(<ApiRequestDialog target={live("user-1")} onClose={() => {}} />);
  expect(queries).toHaveLength(1);
  expect(document.body.textContent).toContain("Capture 1 instructions");
  expect(loaders()).toBe(0);
  const body = document.querySelector('[data-slot="request-viewport"]');

  // A turn streams in and settles: a later prompt closes this message's
  // window, and the re-read entries hand the prompt its persisted id.
  await act(async () => root.render(<ApiRequestDialog target={live("entry-9", "2026-09-06T10:05:00.000Z")} onClose={() => {}} />));
  await settle();

  expect(queries).toHaveLength(1);
  expect(contents).toHaveLength(0);
  expect(loaders()).toBe(0);
  expect(picker().value).toBe("1");
  expect(document.querySelector('[data-slot="request-viewport"]')).toBe(body);
  expect(document.body.textContent).toContain("Capture 1 instructions");
});

it("still asks the host again on Refresh, offering a new capture without blanking the one being read", async () => {
  await mount(<ApiRequestDialog target={live("user-1")} onClose={() => {}} />);
  expect(picker().options).toHaveLength(1);

  hold = true;
  await refresh();
  // While the host answers, the person keeps reading what they opened.
  expect(loaders()).toBe(0);
  expect(document.body.textContent).toContain("Capture 1 instructions");
  expect(picker().value).toBe("1");

  await act(async () => { held!([capture(1), capture(2)]); });
  await settle();
  expect(queries).toHaveLength(2);
  expect(picker().options).toHaveLength(2);
  expect(picker().value).toBe("1");
  expect(document.body.textContent).toContain("Capture 1 instructions");

  // And the new capture is reachable: it is offered, not chosen for them.
  await act(async () => { picker().value = "2"; picker().dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(document.body.textContent).toContain("Capture 2 instructions");
});

it("keeps a failed re-read beside the capture instead of replacing it", async () => {
  await mount(<ApiRequestDialog target={live("user-1")} onClose={() => {}} />);
  client.request.mockImplementation(async (method: string) => {
    if (method === "pi/logs/query") throw new Error("host unreachable");
    return { entries: [] };
  });
  await refresh();
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Check the host connection");
  expect(document.body.textContent).toContain("Capture 1 instructions");
  expect(loaders()).toBe(0);
});

it("fetches a referenced payload once for a capture, however often it is re-read", async () => {
  offered = [capture(1, { detail: undefined, detailRef: { ref: "a".repeat(64), bytes: 9e6, contentType: "application/json", preview: "payload" } })];
  await mount(<ApiRequestDialog target={live("user-1")} onClose={() => {}} />);
  await settle();
  expect(contents).toHaveLength(1);
  expect(document.body.textContent).toContain("Referenced capture instructions");

  await refresh();
  await settle();
  expect(queries).toHaveLength(2);
  expect(contents).toHaveLength(1);
  expect(loaders()).toBe(0);
});

it("shows the message it was opened on, not the one before it", async () => {
  await mount(<ApiRequestDialog target={live("user-1")} onClose={() => {}} />);
  expect(document.body.textContent).toContain("Capture 1 instructions");
  await act(async () => root.unmount());
  container.remove();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  offered = [capture(2)];
  await mount(<ApiRequestDialog target={live("user-2")} onClose={() => {}} />);
  expect(queries.at(-1)).toMatchObject({ promptEntryId: "user-2" });
  expect(document.body.textContent).toContain("Capture 2 instructions");
});
