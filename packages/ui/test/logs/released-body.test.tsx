// @vitest-environment happy-dom
/**
 * M16-T34 / D-245: a request whose body the store released is not an error and
 * not an empty page. The inspector says what happened and shows the summary
 * that was kept; the log detail pane says the same thing in its own width.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogBodySummary, LogEntry } from "@lasercode/protocol";
import { ApiRequestDialog as Inspector } from "../../src/components/logs/ApiRequestDialog.js";
import { LogDetail } from "../../src/components/logs/LogDetail.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { ComponentProps, ReactNode } from "react";

function ApiRequestDialog(props: ComponentProps<typeof Inspector>) {
  return <TooltipProvider><Inspector {...props} /></TooltipProvider>;
}

const client = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client }) }));

let container: HTMLDivElement;
let root: Root;

const released: LogBodySummary = {
  reason: "session-limit",
  bytes: 1_100_000,
  summary: "claude-sonnet-4-5 · 412 messages · 1.0 MB",
  preview: '{"model":"claude-sonnet-4-5","messages":[{"role":"user",',
  at: "2026-09-06T10:00:00.000Z",
  model: "claude-sonnet-4-5",
  messages: 412,
};

const entry: LogEntry = {
  id: 7,
  at: "2026-09-06T10:00:00.000Z",
  section: "provider",
  kind: "provider_request",
  level: "info",
  summary: released.summary,
  sessionPath: "/session",
  requestContext: { promptEntryId: "user-1", provider: "anthropic", model: "claude-sonnet-4-5" },
  detailRef: { ref: "a".repeat(64), bytes: released.bytes, contentType: "application/json", preview: released.preview, released: true },
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  client.request.mockReset();
  client.subscribe.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const mount = async (element: ReactNode) => {
  await act(async () => root.render(element));
  await act(async () => { await import("../../src/components/logs/ApiRequestDialogBody.js"); });
};

const answer = (result: unknown) => {
  client.request.mockImplementation((method: string) => {
    if (method === "pi/logs/content") return Promise.resolve(result);
    if (method === "pi/logs/query") return Promise.resolve({ entries: [entry], hasMore: false });
    return Promise.resolve({ entries: [] });
  });
};

it("explains a released request body in the inspector and offers what was kept", async () => {
  answer({ ref: entry.detailRef!.ref, contentType: "application/json", bytes: released.bytes, truncated: false, text: "", released });
  await mount(<ApiRequestDialog target={{ kind: "log", entry }} onClose={() => {}} />);

  const text = document.body.textContent ?? "";
  expect(text).toContain("Only this request’s summary was kept");
  expect(text).toContain("newer requests since");
  // The summary that was kept, in a person's units — not a byte count or a hash.
  expect(text).toContain("claude-sonnet-4-5");
  expect(text).toContain("412");
  expect(text).toContain("1.0 MB");
  expect(text).toContain(released.preview);
  // Not an error, and not the "nothing was recorded" state either.
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(text).not.toContain("could not be loaded");
  expect(text).not.toContain("Full payloads may have been disabled");
});

it("names the reason the store gives, not a generic one", async () => {
  answer({
    ref: entry.detailRef!.ref, contentType: "application/json", bytes: released.bytes, truncated: false, text: "",
    released: { ...released, reason: "budget" },
  });
  await mount(<ApiRequestDialog target={{ kind: "log", entry }} onClose={() => {}} />);
  expect(document.body.textContent).toContain("size limit for the whole store");
});

it("still renders a body that is stored, with no released notice", async () => {
  answer({
    ref: entry.detailRef!.ref, contentType: "application/json", bytes: 40, truncated: false,
    text: JSON.stringify({ model: "claude-sonnet-4-5", input: [{ role: "user", content: "hello" }] }),
  });
  await mount(<ApiRequestDialog target={{ kind: "log", entry }} onClose={() => {}} />);
  expect(document.body.textContent).not.toContain("Only this request’s summary was kept");
  const conversation = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Conversation"));
  await act(async () => conversation!.click());
  expect(document.body.textContent).toContain("hello");
});

it("explains a capture whose body was never kept, with its size, fingerprint and reason", async () => {
  // RP-7: the request happened and is recorded; only its text is missing, and
  // the page says which body this was and why it is not here.
  answer({
    ref: entry.detailRef!.ref, contentType: "application/json", bytes: 18_874_368, truncated: false, text: "",
    released: { ...released, reason: "over-ceiling", bytes: 18_874_368, sha256: "b".repeat(64) },
  });
  await mount(<ApiRequestDialog target={{ kind: "log", entry }} onClose={() => {}} />);
  const text = document.body.textContent ?? "";
  expect(text).toContain("larger than the size kept in full");
  expect(text).toContain("18.0 MB");
  expect(text).toContain("bbbbbbbbbbbb…bbbb");
  expect(text).toContain("redacted copy this app would have kept");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("names every reason the store or the capture can give", async () => {
  const sentences: Record<string, string> = {
    "link-busy": "busy receiving this session's own updates",
    "summary-mode": "keep request summaries only",
    interrupted: "stopped before all of it had arrived",
    corrupt: "did not match the size and fingerprint",
  };
  for (const [reason, sentence] of Object.entries(sentences)) {
    answer({
      ref: entry.detailRef!.ref, contentType: "application/json", bytes: released.bytes, truncated: false, text: "",
      released: { ...released, reason: reason as never },
    });
    await mount(<ApiRequestDialog target={{ kind: "log", entry }} onClose={() => {}} />);
    expect(document.body.textContent, reason).toContain(sentence);
    await act(async () => root.render(<></>));
  }
});

it("says the same thing in the log detail pane", async () => {
  answer({ ref: entry.detailRef!.ref, contentType: "application/json", bytes: released.bytes, truncated: false, text: "", released });
  await act(async () => root.render(<TooltipProvider><LogDetail entry={entry} /></TooltipProvider>));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Only this request’s summary was kept");
  expect(text).not.toContain("This row has no payload");
  expect(document.querySelector('[data-slot="released-body"]')).not.toBeNull();
});
