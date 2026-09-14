// @vitest-environment happy-dom
/**
 * Registering the service worker is one act, however many callers ask for it
 * (M16-T47 · review #46). Two callers before the browser has answered used to
 * register twice and add a second `message` listener, so every message the
 * worker posted arrived twice — and one of the two registrations was the one
 * nothing held.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { onServiceWorkerMessage, registerServiceWorker, resetServiceWorkerState } from "../../src/pwa/register.js";

interface FakeRegistration { waiting: null; installing: null; addEventListener: () => void; update: () => Promise<void> }

const listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
let calls = 0;
let answer: (registration: FakeRegistration) => void;
let pending: Promise<FakeRegistration>;
const registration: FakeRegistration = { waiting: null, installing: null, addEventListener: () => {}, update: async () => {} };

beforeEach(() => {
  resetServiceWorkerState();
  listeners.clear();
  calls = 0;
  pending = new Promise<FakeRegistration>((resolve) => { answer = resolve; });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: null,
      register: vi.fn(() => { calls += 1; return pending; }),
      addEventListener: (name: string, listener: (event: { data: unknown }) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
    },
  });
});
afterEach(() => {
  resetServiceWorkerState();
  vi.restoreAllMocks();
});

it("registers once for concurrent callers and delivers each message once", async () => {
  const both = Promise.all([registerServiceWorker(), registerServiceWorker()]);
  expect(calls).toBe(1);
  answer(registration);
  await both;
  expect(calls).toBe(1);
  expect(listeners.get("message")).toHaveLength(1);

  const seen: unknown[] = [];
  onServiceWorkerMessage((data) => seen.push(data));
  for (const listener of listeners.get("message") ?? []) listener({ data: { type: "lasercode:navigate" } });
  expect(seen).toHaveLength(1);

  // A later caller joins the registration that already happened.
  await registerServiceWorker();
  expect(calls).toBe(1);
});
