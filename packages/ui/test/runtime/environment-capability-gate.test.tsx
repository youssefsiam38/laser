// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../world/fake-host.js")).FakeHostClient,
}));

import { CapabilityNotice } from "../../src/components/capability-gate.js";
import { LaserProvider, useCapability, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { createWorld, FakeHostClient, settle } from "../world/fake-host.js";
import { testDescriptor } from "./environment-fixture.js";

let root: Root;
let container: HTMLDivElement;

function Surface() {
  const { startupRestoring, client } = useLaserStable();
  const logs = useCapability("pi/logs/query");
  const write = useCapability("pi/settings/set", { presentation: "explained" });
  return <div data-restoring={startupRestoring || undefined}>
    {logs.state === "available" ? <button>Logs</button> : null}
    {write.state === "explained" ? <CapabilityNotice explanation={write.explanation!} /> : null}
    {write.state !== "hidden" ? <button disabled={write.state !== "available"} onClick={() => void client.request("pi/settings/set", { cwd: "/repo", scope: "global", changes: [] })}>Save settings</button> : null}
  </div>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  FakeHostClient.reset(createWorld());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps every affordance hidden inside the existing startup state before a descriptor", async () => {
  FakeHostClient.environment = null;
  await act(async () => { root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>); await settle(20); });
  expect(container.querySelector("[data-restoring=true]")).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
});

it("keeps reads interactive, disables only mutation, and emits no denied request", async () => {
  FakeHostClient.environment = testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"] });
  await act(async () => { root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>); await settle(40); });
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.find((button) => button.textContent === "Logs")?.disabled).toBe(false);
  const save = buttons.find((button) => button.textContent === "Save settings");
  expect(save?.disabled).toBe(true);
  expect(container.textContent).toContain("read these settings");
  save?.click();
  expect(FakeHostClient.world.calls.filter(({ method }) => method === "pi/settings/set")).toHaveLength(0);
});

it("reacts immediately to a mid-session authority downgrade", async () => {
  await act(async () => { root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>); await settle(40); });
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save settings")?.disabled).toBe(false);
  await act(async () => { FakeHostClient.current.redescribe(testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"] })); await settle(20); });
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save settings")?.disabled).toBe(true);
});
