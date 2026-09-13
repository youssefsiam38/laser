// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogBody } from "../../src/dialogs/DialogBody.js";
import { dialogFormOf } from "../../src/dialogs/model.js";
import { QuestionPresentation, TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";
import { initialState } from "../../src/store.js";
import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { ToolRowScope, useRegisterToolRow, useToolRowIds } from "../../src/dialogs/tool-rows.js";

let host: HTMLDivElement, root: Root;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const form = dialogFormOf({ id: "request", method: "input", title: "Name", timeout: 10000 }, false)!;
const type = async (text: string) => {
  const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
};
it("retains typed fields and pending submission across relocation; sibling scopes share the submission guard", async () => {
  const presentation = new TranscriptPresentation();
  const owner = presentation.question("/one", form);
  let resolve!: () => void;
  const send = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const render = (location: string) => act(async () => root.render(<div key={location}><DialogBody form={form} presentation={owner} onAnswer={send} /></div>));
  await render("inline"); await type("unsent exact value");
  host.tabIndex = -1; host.focus();
  await render("footer"); expect(host.querySelector("input")!.value).toBe("unsent exact value");
  expect(document.activeElement).toBe(host);
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Submit")!.click());
  await render("inline-again"); expect(owner.getSnapshot().busy).toBe(true);
  await owner.answer(send); expect(send).toHaveBeenCalledTimes(1);
  expect(presentation.question("/one", form)).toBe(owner);
  expect(presentation.question("/two", form)).not.toBe(owner);
  await act(async () => resolve()); expect(owner.getSnapshot().busy).toBe(false);
  expect(send).toHaveBeenCalledWith({ value: "unsent exact value" });
});
it("keeps a deadline through remount and a failed submission retry, and fences a settled owner", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const timed = { ...form, timeoutMs: 10000 };
  const registry = new TranscriptPresentation();
  const owner = registry.question("/one", timed);
  expect(owner.deadline).toBe(11000);
  owner.setValue("value", "retry me"); owner.setDeclining(true);
  await expect(owner.answer(async () => { throw Error("refused"); })).rejects.toThrow("refused");
  expect(owner.getSnapshot()).toEqual({ values: { value: "retry me" }, declining: true, busy: false });
  vi.setSystemTime(7000); expect(registry.question("/one", timed).deadline).toBe(11000);
  let resolve!: () => void;
  const pending = owner.answer(() => new Promise<void>(done => { resolve = done; }));
  registry.reconcile(initialState);
  const successor = registry.question("/one", timed);
  expect(successor).not.toBe(owner); expect(successor.deadline).toBe(17000);
  resolve(); await pending;
  const send = vi.fn(async () => {}); await owner.answer(send); expect(send).not.toHaveBeenCalled();
  await successor.answer(send); expect(send).toHaveBeenCalledOnce();
});
it("retains answers and the deadline through the real optimistic remove/failed-response restoration boundary", async () => {
  const store = createStateStore();
  const path = "/one";
  store.dispatch({ type: "opened", state: { path, id: "one", cwd: "/project", model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: false, messageCount: 0, pendingMessageCount: 0 } });
  const request = { path, id: form.id, method: "input" as const, title: "Name" };
  store.dispatch({ type: "notification", method: "pi/ui/request", params: request });
  const owner = store.presentation!.question(path, { ...form, timeoutMs: 10000 });
  owner.setValue("value", "keep on retry");
  const deadline = owner.deadline;
  let reject!: (error: Error) => void;
  const pending = owner.answer(async () => {
    store.dispatch({ type: "dialogAnswered", path, id: form.id });
    try { await new Promise<void>((_, fail) => { reject = fail; }); }
    catch (error) { store.dispatch({ type: "notification", method: "pi/ui/request", params: request }); throw error; }
  });
  expect(store.getSnapshot().open[path]!.dialogs).toHaveLength(0);
  const failed = expect(pending).rejects.toThrow("network"); reject(Error("network")); await failed;
  const retry = store.presentation!.question(path, form);
  expect(retry).toBe(owner); expect(retry.deadline).toBe(deadline);
  expect(retry.getSnapshot()).toEqual({ values: { value: "keep on retry" }, declining: false, busy: false });
  await owner.answer(async () => { store.dispatch({ type: "dialogAnswered", path, id: form.id }); });
  expect(store.presentation!.question(path, form)).not.toBe(owner);
});
function Row({ id }: { id: string }) { useRegisterToolRow(id); return null; }
function Placement({ label }: { label: string }) { const ids = useToolRowIds(); return <output aria-label={label}>{[...ids].join(",")}</output>; }
it("does not let a mounted main-thread tool suppress the Beam footer fallback", async () => {
  await act(async () => root.render(<><ToolRowScope scope="/same"><Row id="tool" /><Placement label="main" /></ToolRowScope><ToolRowScope scope="/same"><Placement label="beam" /></ToolRowScope></>));
  expect(host.querySelector('[aria-label="main"]')!.textContent).toBe("tool");
  expect(host.querySelector('[aria-label="beam"]')!.textContent).toBe("");
  await act(async () => root.render(<><ToolRowScope scope="/next"><Placement label="main" /></ToolRowScope><ToolRowScope scope="/same"><Row id="beam-tool" /><Placement label="beam" /></ToolRowScope></>));
  expect(host.querySelector('[aria-label="main"]')!.textContent).toBe("");
  expect(host.querySelector('[aria-label="beam"]')!.textContent).toBe("beam-tool");
});
it("keeps independent local approval owners independent", () => {
  const a = new QuestionPresentation(form), b = new QuestionPresentation(form);
  a.setValue("value", "a"); expect(b.getSnapshot().values).toEqual({});
});
