// @vitest-environment happy-dom
/**
 * The first connection of a page's life (RP-13 B).
 *
 * Device storage is shut until the descriptor lands, so every store that
 * remembers something starts empty — and the moment the environment opens, it
 * has to *find* what the person left behind rather than overwrite it with that
 * empty start. This is the case a store that only listened for environment
 * switches would get wrong, quietly and permanently, so it is tested through a
 * real mount with everything seeded at once.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { DEVICE_KEYS, deviceStore } from "../../src/runtime/device-storage.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { sessionFolds, foldKey } from "../../src/components/assistant-ui/elements/session-folds.js";
import { beamStore } from "../../src/components/beam/beam-store.js";
import { resetFleetState, useFleetClearedBefore } from "../../src/fleet/fleet-state.js";
import { readDraft } from "../../src/components/assistant-ui/elements/draft-restore.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";
import { seedDeviceValue, seedDestination, seedFingerprint } from "./environment-fixture.js";

const SESSION = `${PROJECT_CWD}/one.jsonl`;
const BEAM = "/state/beam/b.jsonl";
const CLEARED_AT = "2026-01-02T03:04:05.000Z";

let world: World;
let root: Root;
let container: HTMLDivElement;
let probe: { archived: boolean; cleared: string | undefined; destinationPath: string | undefined };

function Probe() {
  const { archive } = useLaserStable();
  const destination = useLaserState((state) => state.destination);
  const cleared = useFleetClearedBefore();
  probe = {
    archived: archive.has("/p/archived.jsonl"),
    cleared,
    destinationPath: "code" in destination && destination.code.kind === "project-session" ? destination.code.path
      : destination.rememberedCode.kind === "project-session" ? destination.rememberedCode.path : undefined,
  };
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  deviceStore.deactivate();
  sessionsList.reset();
  sessionFolds.reset();
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

it("finds everything this environment remembered, on the very first connection", async () => {
  // What a previous visit to this environment left on the device.
  seedFingerprint();
  seedDeviceValue(DEVICE_KEYS.sessionPins, JSON.stringify([SESSION]));
  seedDeviceValue(DEVICE_KEYS.sessionGroups, JSON.stringify(["/one", "/two"]));
  seedDeviceValue(DEVICE_KEYS.sessionFolds, JSON.stringify({ [foldKey("children", SESSION)]: false }));
  seedDeviceValue(DEVICE_KEYS.archived, JSON.stringify(["/p/archived.jsonl"]));
  seedDeviceValue(DEVICE_KEYS.beamSession, BEAM);
  seedDeviceValue(DEVICE_KEYS.fleetCleared, CLEARED_AT);
  seedDestination({ tab: "code", code: { kind: "project-session", project: PROJECT_CWD, path: SESSION } });
  seedDeviceValue(DEVICE_KEYS.drafts, JSON.stringify({ [SESSION]: { text: "half a sentence", at: new Date().toISOString() } }));

  // Nothing is readable yet: the app has not been told where it is.
  expect(sessionsList.get().pinned.size).toBe(0);
  expect(beamStore.getSnapshot().path).toBeUndefined();
  expect(readDraft(SESSION)).toBeUndefined();

  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>);
    await settle(40);
  });

  expect(sessionsList.get().pinned.has(SESSION)).toBe(true);
  expect([...sessionsList.get().collapsed].sort()).toEqual(["/one", "/two"]);
  expect(sessionFolds.get().chosen.get(foldKey("children", SESSION))).toBe(false);
  expect(beamStore.getSnapshot().path).toBe(BEAM);
  expect(readDraft(SESSION)?.text).toBe("half a sentence");
  expect(probe.archived).toBe(true);
  expect(probe.cleared).toBe(CLEARED_AT);
  expect(probe.destinationPath).toBe(SESSION);

  // And none of it was overwritten by an empty start: the stored values are
  // still there afterwards, unchanged.
  expect(JSON.parse(localStorage.getItem(`lasercode-env:e1.AAAAAAAAAAAAAAAAAAAAAA:${DEVICE_KEYS.sessionPins}`)!)).toEqual([SESSION]);
  expect(localStorage.getItem(`lasercode-env:e1.AAAAAAAAAAAAAAAAAAAAAA:${DEVICE_KEYS.beamSession}`)).toBe(BEAM);
});

it("keeps nothing of it when the environment never arrives", async () => {
  seedFingerprint();
  seedDeviceValue(DEVICE_KEYS.sessionPins, JSON.stringify([SESSION]));
  seedDeviceValue(DEVICE_KEYS.beamSession, BEAM);
  FakeHostClient.environment = null;

  await act(async () => {
    root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>);
    await settle(40);
  });

  expect(sessionsList.get().pinned.size).toBe(0);
  expect(beamStore.getSnapshot().path).toBeUndefined();
  expect(probe.archived).toBe(false);
  expect(probe.cleared).toBeUndefined();
  // Not read, and not destroyed either: this view simply has no business with
  // it until it knows whose it is.
  expect(localStorage.getItem(`lasercode-env:e1.AAAAAAAAAAAAAAAAAAAAAA:${DEVICE_KEYS.beamSession}`)).toBe(BEAM);
});
