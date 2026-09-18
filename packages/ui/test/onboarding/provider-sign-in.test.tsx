// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderAuthInfo, ProviderLoginEvent } from "@lasercode/protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../src/runtime/index.js", () => { const stable = { client: mocks }; return { useLaserStable: () => stable }; });
import { ProviderSignIn } from "../../src/components/onboarding/ProviderSignIn.js";
let root: Root, container: HTMLDivElement, listener: (method: string, params: unknown) => void;
const provider: ProviderAuthInfo = { id: "openai", name: "OpenAI", configured: false, oauth: false, subscription: false, modelCount: 1 };
const emit = (event: ProviderLoginEvent) => listener("pi/providers/login/event", { cwd: "/project", provider: "openai", id: "login", event });
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  mocks.request.mockReset().mockResolvedValue({ id: "login" });
  mocks.subscribe.mockImplementation((fn) => { listener = fn; return () => {}; });
  await act(async () => root.render(<ProviderSignIn routeCwd="/project" provider={provider} method="api_key" onDone={() => {}} onCancel={() => {}} />));
  await act(async () => emit({ type: "prompt", prompt: { id: "key", kind: "secret", message: "API key" } }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function submit() {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fake-test-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
it("shows progress during the answer request and does not erase a terminal event", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await submit();
  expect(container.querySelector('[data-slot="generation-loader"]')?.textContent).toContain("Saving API key");
  expect(container.querySelector('button[type="submit"]')?.textContent).toContain("Connecting");
  expect(container.querySelector("input")?.disabled).toBe(true);
  await act(async () => emit({ type: "done", method: "api_key" }));
  await act(async () => resolve({}));
  expect(container.querySelector('[data-slot="generation-loader"]')).toBeNull();
  expect(container.textContent).toContain("API key saved for OpenAI");
  expect(container.textContent).not.toContain("Signed in");
});
it("retains real provider progress after acknowledgement and exits loading on failure", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await submit();
  await act(async () => emit({ type: "progress", message: "Testing connection with provider…" }));
  await act(async () => resolve({}));
  expect(container.querySelector('[data-slot="generation-loader"]')?.textContent).toContain("Testing connection with provider");
  await act(async () => emit({ type: "error", message: "Provider rejected this credential." }));
  expect(container.querySelector('[data-slot="generation-loader"]')).toBeNull();
  expect(container.textContent).toContain("Provider rejected this credential");
  expect(container.textContent).toContain("Try again");
});
it("stops loading when submitting the answer fails", async () => {
  mocks.request.mockRejectedValueOnce(new Error("Host connection lost"));
  await submit();
  expect(container.querySelector('[data-slot="generation-loader"]')).toBeNull();
  expect(container.textContent).toContain("Host connection lost");
});

it("cancels a delayed obsolete start instead of adopting it into a newer attempt", async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  let resolveOld!: (value: { id: string }) => void;
  let starts = 0;
  mocks.request.mockReset().mockImplementation((method: string) => {
    if (method === "pi/providers/login/start") {
      starts += 1;
      if (starts === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve({ id: "new-login" });
    }
    return Promise.resolve({});
  });

  const props = { routeCwd: "/project", provider, onDone: () => {}, onCancel: () => {} };
  await act(async () => root.render(<ProviderSignIn {...props} method="api_key" />));
  await act(async () => root.render(<ProviderSignIn {...props} method="oauth" />));
  await act(async () => { resolveOld({ id: "old-login" }); await Promise.resolve(); });

  expect(mocks.request).toHaveBeenCalledWith("pi/providers/login/cancel", { cwd: "/project", id: "old-login" });
  await act(async () => listener("pi/providers/login/event", {
    cwd: "/project",
    provider: "openai",
    id: "new-login",
    event: { type: "prompt", prompt: { id: "new-key", kind: "secret", message: "New API key" } },
  }));
  expect(container.textContent).toContain("New API key");
});

it("cancels a start that resolves after unmount", async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  let resolveStart!: (value: { id: string }) => void;
  mocks.request.mockReset().mockImplementation((method: string) => {
    if (method === "pi/providers/login/start") return new Promise((resolve) => { resolveStart = resolve; });
    return Promise.resolve({});
  });
  await act(async () => root.render(<ProviderSignIn routeCwd="/project" provider={provider} method="api_key" onDone={() => {}} onCancel={() => {}} />));
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => { resolveStart({ id: "late-login" }); await Promise.resolve(); });
  expect(mocks.request).toHaveBeenCalledWith("pi/providers/login/cancel", { cwd: "/project", id: "late-login" });
});
