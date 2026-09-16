// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { CapabilityGate } from "../../src/components/capability-gate.js";
import { LaserProvider, useCapability, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { createWorld, FakeHostClient, settle } from "../beam/fake-host.js";
import { testDescriptor } from "./environment-fixture.js";

let root: Root;
let container: HTMLDivElement;

function Surface() {
  const { startupRestoring } = useLaserStable();
  const logs = useCapability("pi/logs/query", { capabilities: ["logs"] });
  return <div data-restoring={startupRestoring || undefined}>
    {logs.state === "available" ? <button>Logs</button> : null}
    <CapabilityGate method="pi/settings/set"><button>Save settings</button></CapabilityGate>
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
  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>);
    await settle(20);
  });
  expect(container.querySelector("[data-restoring=true]")).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("[data-slot=guardrail-notice]")).toBeNull();
});

it("keeps readable content, disables its write controls, and explains a missing scope", async () => {
  FakeHostClient.environment = testDescriptor({ scopes: ["handshake", "read", "diagnostics"] });
  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>);
    await settle(40);
  });
  expect(container.textContent).toContain("Logs");
  expect(container.textContent).toContain("read these settings");
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save settings");
  expect(save?.closest("fieldset")?.disabled).toBe(true);
});

it("reacts immediately when the same environment reconnects with narrower authority", async () => {
  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>);
    await settle(40);
  });
  let save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save settings");
  expect(save?.closest("fieldset")).toBeNull();

  await act(async () => {
    FakeHostClient.current.redescribe(testDescriptor({ scopes: ["handshake", "read", "diagnostics"] }));
    await settle(20);
  });
  save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save settings");
  expect(save?.closest("fieldset")?.disabled).toBe(true);
  expect(container.textContent).toContain("read these settings");
});

it("renders the same controls normally when the descriptor grants them", async () => {
  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Surface /></LaserProvider>);
    await settle(40);
  });
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Logs", "Save settings"]);
  expect(container.querySelector("[data-slot=guardrail-notice]")).toBeNull();
});
