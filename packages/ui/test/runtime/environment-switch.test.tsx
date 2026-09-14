// @vitest-environment happy-dom
/**
 * Moving between environments, in the app (RP-13, M18-T13 B).
 *
 * A laptop can talk to a local host today and a hosted workspace tomorrow.
 * What it kept for the first must not appear in the second — not the sessions
 * in the sidebar, not the open transcript, not the pins, the archive, the
 * remembered destination, the Beam chat, the fleet's "I have read these" mark,
 * and not a draft somebody typed. And when the app cannot establish an
 * environment at all, it must keep nothing rather than keep guessing.
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { DEVICE_KEYS, deviceStore, namespaceOf } from "../../src/runtime/device-storage.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { beamStore } from "../../src/components/beam/beam-store.js";
import { clearFinishedFleet, resetFleetState, useFleetClearedBefore } from "../../src/fleet/fleet-state.js";
import { readDraft, writeDraft } from "../../src/components/assistant-ui/elements/draft-restore.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";
import { OTHER_ENVIRONMENT_KEY, TEST_ENVIRONMENT_KEY, deviceKeyName, testDescriptor } from "./environment-fixture.js";

const SESSION = `${PROJECT_CWD}/one.jsonl`;

let world: World;
let root: Root;
let container: HTMLDivElement;
let probe: {
  sessions: number;
  open: number;
  current: string | undefined;
  environmentKey: string | undefined;
  error: string | undefined;
  cleared: string | undefined;
  openSession(path: string): Promise<void>;
};

function Probe() {
  const { actions } = useLaserStable();
  const sessions = useLaserState((state) => state.sessions.length);
  const open = useLaserState((state) => Object.keys(state.open).length);
  const current = useLaserState((state) => state.current);
  const environment = useLaserState((state) => state.environment);
  const error = useLaserState((state) => state.environmentError);
  const cleared = useFleetClearedBefore();
  useEffect(() => {
    probe = { sessions, open, current, environmentKey: environment?.environmentKey, error, cleared, openSession: actions.openSession };
  });
  probe = { sessions, open, current, environmentKey: environment?.environmentKey, error, cleared, openSession: actions.openSession };
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  deviceStore.deactivate();
  sessionsList.reset();
  beamStore.reset();
  resetFleetState();
  world = createWorld();
  addSession(world, SESSION, PROJECT_CWD);
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  deviceStore.deactivate();
});

const mount = async () => {
  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>);
    await settle(40);
  });
};

it("leaves nothing of one environment behind in the next", async () => {
  await mount();
  expect(probe.environmentKey).toBe(TEST_ENVIRONMENT_KEY);

  // A person's afternoon in the first environment: a session open, a pin, a
  // Beam chat, a draft and the fleet put away.
  await act(async () => { await probe.openSession(SESSION); await settle(20); });
  await act(async () => { sessionsList.togglePinned(SESSION); beamStore.setPath("/state/beam/b.jsonl"); });
  writeDraft(SESSION, "half a sentence, in the first environment");
  clearFinishedFleet("2026-01-01T00:00:00.000Z");
  expect(probe.open).toBe(1);
  expect(probe.current).toBe(SESSION);
  expect(sessionsList.get().pinned.has(SESSION)).toBe(true);
  expect(readDraft(SESSION)?.text).toContain("first environment");
  expect(localStorage.getItem(deviceKeyName(DEVICE_KEYS.sessionPins))).toContain(SESSION);

  // The same laptop, reconnected to somewhere else entirely.
  const before = world.calls.length;
  await act(async () => {
    FakeHostClient.current.redescribe(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY, deployment: "cloud" }));
  });
  expect(probe.environmentKey).toBe(OTHER_ENVIRONMENT_KEY);
  expect(sessionsList.get().pinned.size).toBe(0);

  await act(async () => settle(40));
  // Whatever the app shows now, it asked *this* environment's host for it, and
  // it asked from the beginning: no watermark from the other environment's
  // session survived to be resumed against a different host.
  const loads = world.calls.slice(before).filter((call) => call.method === "session/load");
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.every((call) => ((call.params as { fromSeq?: number }).fromSeq ?? 0) === 0)).toBe(true);
  expect(beamStore.getSnapshot().path).toBeUndefined();
  expect(probe.cleared).toBeUndefined();
  expect(readDraft(SESSION)).toBeUndefined();
  // And the first environment's own namespace is gone from the device.
  const namespaces = new Set(Object.keys(localStorage).map(namespaceOf).filter(Boolean));
  expect([...namespaces]).toEqual([OTHER_ENVIRONMENT_KEY]);
});

it("finds each environment's own memory again when it comes back", async () => {
  await mount();
  await act(async () => sessionsList.togglePinned(SESSION));
  expect(sessionsList.get().pinned.has(SESSION)).toBe(true);

  // Away and back. The second environment never saw that pin; the first still
  // has it, because leaving an environment is not forgetting it — it is the
  // *other* environment's namespace that is purged when it is not in use.
  await act(async () => {
    FakeHostClient.current.redescribe(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY }));
    await settle(20);
  });
  expect(sessionsList.get().pinned.size).toBe(0);
  await act(async () => sessionsList.togglePinned("/elsewhere/other.jsonl"));

  await act(async () => {
    FakeHostClient.current.redescribe(testDescriptor({ environmentKey: TEST_ENVIRONMENT_KEY }));
    await settle(20);
  });
  // The first environment's pins were purged while the second was in use, so
  // what comes back is this environment's namespace as it now stands — and
  // never the other environment's pin.
  expect(sessionsList.get().pinned.has("/elsewhere/other.jsonl")).toBe(false);
  await act(async () => sessionsList.togglePinned(SESSION));
  expect(localStorage.getItem(deviceKeyName(DEVICE_KEYS.sessionPins))).toContain(SESSION);
});

it("keeps the live session through a reconnect into the same environment", async () => {
  await mount();
  await act(async () => { await probe.openSession(SESSION); await settle(20); });
  await act(async () => sessionsList.togglePinned(SESSION));
  expect(probe.open).toBe(1);

  await act(async () => {
    FakeHostClient.current.redescribe(testDescriptor());
    await settle(20);
  });
  expect(probe.open).toBe(1);
  expect(probe.current).toBe(SESSION);
  expect(sessionsList.get().pinned.has(SESSION)).toBe(true);
});

it("invalidates what a narrowed descriptor took away, and keeps the rest", async () => {
  await mount();
  await act(async () => sessionsList.togglePinned(SESSION));
  writeDraft(SESSION, "typed while drafts were allowed");
  expect(readDraft(SESSION)).toBeDefined();

  await act(async () => {
    // Same environment, stricter policy: no transcript content on devices.
    FakeHostClient.current.redescribe(testDescriptor({ cache: { transcripts: "disabled" } }));
    await settle(20);
  });
  expect(readDraft(SESSION)).toBeUndefined();
  writeDraft(SESSION, "typed after");
  expect(readDraft(SESSION)).toBeUndefined();
  expect(localStorage.getItem(deviceKeyName(DEVICE_KEYS.drafts))).toBeNull();
  // A tightened cache is not a different environment: the pin survives.
  expect(sessionsList.get().pinned.has(SESSION)).toBe(true);
});

it("keeps nothing at all when the environment cannot be established", async () => {
  FakeHostClient.environment = null;
  localStorage.setItem("lasercode-draft:/p/one.jsonl", '{"text":"from before"}');
  localStorage.setItem("lasercode-panels", "{}");
  await mount();

  // The pre-environment keys are unsafe wherever this view turns out to be, so
  // they go even though it never learned where that is.
  expect(localStorage.getItem("lasercode-draft:/p/one.jsonl")).toBeNull();
  expect(localStorage.getItem("lasercode-panels")).toBe("{}");

  expect(probe.error).toMatch(/environment/i);
  expect(probe.environmentKey).toBeUndefined();
  expect(probe.sessions).toBe(0);
  expect(deviceStore.status().active).toBe(false);

  // Nothing can be written, by anybody, while the app does not know where it is.
  writeDraft(SESSION, "typed into the void");
  await act(async () => sessionsList.togglePinned(SESSION));
  expect(Object.keys(localStorage)).toEqual(["lasercode-panels"]);
  expect(readDraft(SESSION)).toBeUndefined();
});

it("purges the pre-environment keys on the way in, whatever they hold", async () => {
  const legacy = {
    "lasercode-draft:/p/one.jsonl": '{"text":"from before environments"}',
    "lasercode-archived": '["/p/one.jsonl"]',
    "lasercode-session": '{"/p":"/p/one.jsonl"}',
    "lasercode-panels": "{}",
  };
  for (const [key, value] of Object.entries(legacy)) localStorage.setItem(key, value);
  await mount();

  expect(localStorage.getItem("lasercode-draft:/p/one.jsonl")).toBeNull();
  expect(localStorage.getItem("lasercode-archived")).toBeNull();
  expect(localStorage.getItem("lasercode-session")).toBeNull();
  // Panel geometry belongs to no environment and is left where it is.
  expect(localStorage.getItem("lasercode-panels")).toBe("{}");
  expect(readDraft("/p/one.jsonl")).toBeUndefined();
});
