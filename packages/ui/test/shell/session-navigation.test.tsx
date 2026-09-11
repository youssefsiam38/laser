// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, useRemoteThreadListRuntime, type RemoteThreadListAdapter } from "@assistant-ui/react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { ThreadList } from "../../src/components/assistant-ui/elements/thread-list.aui.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { sessionsList, SESSION_PINS_STORAGE_KEY } from "../../src/components/shell/session-groups.js";

const fixture = vi.hoisted(() => ({ state: { sessions: [
  { path: "/one/working.jsonl", cwd: "/one", name: "Active work", modifiedAt: "2026-09-07T03:00:00Z", messageCount: 2, attention: "working" },
  { path: "/one/finished.jsonl", cwd: "/one", name: "Finished work", modifiedAt: "2026-09-07T02:00:00Z", messageCount: 2, attention: "finished_unread" },
  { path: "/two/waiting.jsonl", cwd: "/two", name: "Review needed", modifiedAt: "2026-09-07T01:00:00Z", messageCount: 2, attention: "waiting_for_input" },
], open: {}, workers: {}, agents: { snapshot: null, loading: false, error: null, runs: {}, events: [], chooseBeamModel: null } } }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/threadList.js"),
  useLaserState: (selector: (s: unknown) => unknown) => selector(fixture.state),
  useLaserStable: () => ({ currentProject: "/one", actions: { toast: vi.fn(), removeProject: vi.fn() }, archive: { add: vi.fn() } }),
}));
const metadata = fixture.state.sessions.map(s => ({ remoteId: s.path, externalId: s.path, title: s.name, status: "regular" as const, custom: { cwd: s.cwd, modifiedAt: s.modifiedAt, attention: s.attention } }));
const archived = { remoteId: "/one/archived.jsonl", externalId: "/one/archived.jsonl", title: "Saved archive", status: "archived" as const, custom: { cwd: "/one" } };
const adapter: RemoteThreadListAdapter = {
  list: async () => ({ threads: [...metadata, archived] }),
  initialize: async (id) => ({ remoteId: id, externalId: id }),
  fetch: async (id) => metadata.find(item => item.remoteId === id)!,
  rename: async () => {}, archive: async () => {}, unarchive: async () => {}, delete: async () => {},
  generateTitle: async () => { throw new Error("Not used"); },
};
const projects = ["/one", "/two"];
function useEmptyRuntime() { return useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} }); }
function Fixture() {
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useEmptyRuntime });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><ThreadList projects={projects} /></TooltipProvider></AssistantRuntimeProvider>;
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sessionsList.reset();
  localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const rows = () => [...container.querySelectorAll('[data-slot="aui_thread-list-item"]')];

describe("compact session navigation", () => {
  it("shows activity only on the chat, as one leading mark per row, and no idle markers", async () => {
    await act(async () => root.render(<Fixture />));
    expect(rows()).toHaveLength(3);
    // M15-T4: working is the shared sweep dot before the name, not a trailing
    // spinner, so a row never wears two marks in two places.
    expect(container.querySelectorAll('[data-slot="session-working"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-status="working"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-status="finished_unread"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-status="waiting_for_input"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-status="idle"]')).toHaveLength(0);
    expect(container.querySelector('[data-status="working"] span')?.getAttribute("class")).toContain("motion-safe:animate-sweep");
    expect(rows()[0]?.textContent).toContain("Active work");
    const header = container.querySelector('[data-cwd="/one"] button')!;
    await act(async () => (header as HTMLButtonElement).click());
    expect(rows()).toHaveLength(1);
    await act(async () => (header as HTMLButtonElement).click());
    expect(rows()).toHaveLength(3);
  });
  it("pins each chat once, preserves project filtering, and persists pin order", async () => {
    await act(async () => root.render(<Fixture />));
    await act(async () => { sessionsList.togglePinned("/two/waiting.jsonl"); sessionsList.togglePinned("/one/working.jsonl"); });
    expect(rows()).toHaveLength(3);
    const pinnedRows = container.querySelectorAll('[data-slot="pinned-sessions"] [data-slot="aui_thread-list-item"]');
    expect(pinnedRows).toHaveLength(2);
    expect(pinnedRows[0]?.textContent).toContain("Review needed");
    expect(pinnedRows[0]?.querySelector('[data-slot="pinned-session-project"]')?.getAttribute("aria-label")).toBe("Project: /two");
    expect(container.querySelector('[data-cwd="/one"]')?.textContent).not.toContain("Active work");
    expect(JSON.parse(localStorage.getItem(SESSION_PINS_STORAGE_KEY)!)).toEqual(["/two/waiting.jsonl", "/one/working.jsonl"]);
    await act(async () => sessionsList.filter("/one"));
    expect(rows()).toHaveLength(2);
    expect(sessionsList.get().pinned.size).toBe(2);
    await act(async () => { sessionsList.clearFilter(); sessionsList.togglePinned("/one/working.jsonl"); });
    expect(rows()).toHaveLength(3);
    expect(container.querySelector('[data-cwd="/one"]')?.textContent).toContain("Active work");
  });
  it("does not mount duplicate inbox, header badges or project attention rings", () => {
    const panel = readFileSync(new NodeURL("../../src/components/shell/SessionsPanel.tsx", import.meta.url), "utf8");
    const rail = readFileSync(new NodeURL("../../src/components/shell/Rail.tsx", import.meta.url), "utf8");
    expect(panel).not.toContain("InboxPanel");
    expect(panel).not.toContain("<Badge");
    expect(rail).not.toContain("status={project.status}");
    expect(rail).not.toContain("{project.needYou}");
  });
  it("never promotes archived or missing pins into the active tree", async () => {
    sessionsList.togglePinned(archived.remoteId);
    sessionsList.togglePinned("/missing/session.jsonl");
    await act(async () => root.render(<Fixture />));
    expect(container.querySelector('[data-slot="pinned-sessions"]')).toBeNull();
    expect(rows()).toHaveLength(3);
    const toggle = container.querySelector<HTMLButtonElement>('section[aria-label="Archived sessions"] button')!;
    await act(async () => toggle.click());
    expect(rows()).toHaveLength(4);
    expect(container.querySelector('[data-pinned="true"]')).toBeNull();
    await act(async () => toggle.click());
    expect(rows()).toHaveLength(3);
  });
});
