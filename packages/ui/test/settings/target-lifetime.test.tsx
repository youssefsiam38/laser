// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  useCommittedTargetLifetime,
  type CommittedTargetLease,
  type CommittedTargetLifetime,
} from "../../src/components/settings/useCommittedTargetLifetime.js";
import { deviceStore } from "../../src/runtime/device-storage.js";
import { OTHER_ENVIRONMENT_KEY, testDescriptor } from "../runtime/environment-fixture.js";

interface Exposed {
  lifetime: CommittedTargetLifetime;
  captureLater: () => CommittedTargetLease | undefined;
}

let root: Root;
let container: HTMLDivElement;
let exposed: Exposed;

function Probe({ target }: { target: string }) {
  const lifetime = useCommittedTargetLifetime(target);
  useLayoutEffect(() => {
    exposed = { lifetime, captureLater: () => lifetime.capture() };
  }, [lifetime]);
  return null;
}

async function render(target: string) {
  await act(async () => root.render(<Probe target={target} />));
  return exposed;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  deviceStore.deactivate();
  deviceStore.activate(testDescriptor());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  deviceStore.deactivate();
});

it("retires old callbacks across A → B → A and unmount", async () => {
  const firstA = await render("A");
  const firstLease = firstA.lifetime.capture();
  expect(firstLease).toBeDefined();

  const b = await render("B");
  expect(firstA.captureLater()).toBeUndefined();
  expect(firstA.lifetime.isCurrent(firstLease)).toBe(false);
  expect(b.lifetime.capture()).toBeDefined();

  const secondA = await render("A");
  expect(firstA.captureLater()).toBeUndefined();
  expect(b.captureLater()).toBeUndefined();
  const secondLease = secondA.lifetime.capture();
  expect(secondLease).toBeDefined();
  expect(secondLease?.handle).not.toBe(firstLease?.handle);

  await act(async () => root.unmount());
  expect(secondA.captureLater()).toBeUndefined();
  root = createRoot(container);
});

it("preserves same-environment reconnect but re-arms narrowed, switched and first activations", async () => {
  const initial = await render("A");
  const initialLease = initial.lifetime.capture();
  expect(initialLease).toBeDefined();

  await act(async () => { deviceStore.activate(testDescriptor()); });
  expect(initial.lifetime.isCurrent(initialLease)).toBe(true);
  expect(initial.captureLater()).toBe(initialLease);

  await act(async () => { deviceStore.activate(testDescriptor({ capabilities: { search: false } })); });
  const narrowed = exposed;
  expect(initial.captureLater()).toBeUndefined();
  expect(initial.lifetime.isCurrent(initialLease)).toBe(false);
  expect(narrowed.lifetime.capture()).toBeDefined();

  await act(async () => { deviceStore.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY })); });
  const switched = exposed;
  expect(narrowed.captureLater()).toBeUndefined();
  expect(switched.lifetime.capture()).toBeDefined();

  await act(async () => { deviceStore.deactivate(); });
  expect(switched.captureLater()).toBeUndefined();
  expect(exposed.lifetime.capture()).toBeUndefined();

  await act(async () => { deviceStore.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY })); });
  const reactivated = exposed;
  expect(switched.captureLater()).toBeUndefined();
  expect(reactivated.lifetime.capture()).toBeDefined();
});
