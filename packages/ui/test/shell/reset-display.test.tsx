// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostClient } from "../../src/client.js";
import { useResetDisplay } from "../../src/components/shell/use-reset-display.js";

let root: Root, container: HTMLDivElement;
const request = vi.fn();
const client = { request, subscribe: vi.fn(() => () => {}) } as unknown as HostClient;
function Harness() {
  const { display, choose, saveError } = useResetDisplay(client);
  return <button onClick={() => choose("time")}>{display}{saveError ? " · save failed" : ""}</button>;
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  request.mockReset(); request.mockResolvedValue({ entries: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("restores the machine preference and saves a selection through the host", async () => {
  request.mockResolvedValueOnce({ entries: [{ value: { resetDisplay: "time" } }] });
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe("time");
  await act(async () => container.querySelector("button")!.click());
  expect(request).toHaveBeenLastCalledWith("pi/prefs/set", { namespace: "account-usage-display", value: { resetDisplay: "time" } });
});
it("does not let a late initial read undo the user's choice", async () => {
  let resolve!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector("button")!.click());
  await act(async () => resolve({ entries: [{ value: { resetDisplay: "remaining" } }] }));
  expect(container.textContent).toBe("time");
});
it("keeps the local choice and explains a failed preference save", async () => {
  await act(async () => root.render(<Harness />));
  request.mockRejectedValueOnce(new Error("offline"));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("time · save failed");
});
