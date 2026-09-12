// @vitest-environment happy-dom
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { storageKey } from "@lasercode/protocol";
vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));
import { LaserProvider, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { addSession, createWorld, FakeHostClient, settle, type World } from "../beam/fake-host.js";

let root: Root;
let container: HTMLDivElement;
let world: World;
let select: (cwd: string) => void;
function Probe() {
  const { setCurrentProject } = useLaserStable();
  useEffect(() => { select = setCurrentProject; }, [setCurrentProject]);
  return null;
}
beforeEach(() => {
  localStorage.clear(); sessionsList.reset();
  world = createWorld(); addSession(world, "/p/s", "/p"); addSession(world, "/q/s", "/q");
  world.overrides["pi/project/list"] = () => ({ projects: ["/p", "/q"].map(cwd => ({ cwd, name: cwd, trust: "trusted", sessionCount: 1, pinned: true, addedAt: "2026-01-01" })) });
  world.overrides["pi/worker/prepare"] = () => ({});
  FakeHostClient.reset(world);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { root.unmount(); await settle(); container.remove(); localStorage.clear(); sessionsList.reset(); });
const hints = () => world.calls.filter(call => call.method === "pi/worker/prepare").map(call => call.params);
async function mount() {
  root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>);
  await vi.waitFor(() => expect(world.calls.some(call => call.method === "pi/project/list")).toBe(true));
  await settle(250);
}
it("prepares only actual remembered project memory, not every catalog/default-open group", async () => {
  localStorage.setItem(storageKey("project"), "/q");
  await mount();
  expect(hints()).toEqual([{ cwd: "/q" }]);
});
it("catalog/default selection alone never prepares, but explicit selection does", async () => {
  await mount(); expect(hints()).toEqual([]);
  select("/q"); await vi.waitFor(() => expect(hints()).toEqual([{ cwd: "/q" }]));
});
it("an explicit group expansion prepares its project and collapse does not", async () => {
  await mount(); sessionsList.toggleCollapsed("/q"); await settle(200); expect(hints()).toEqual([]);
  sessionsList.toggleCollapsed("/q"); await vi.waitFor(() => expect(hints()).toEqual([{ cwd: "/q" }]));
});
it("unmount cancels a pending readiness hint", async () => {
  await mount(); select("/q"); root.render(null); await settle(250); expect(hints()).toEqual([]);
});
