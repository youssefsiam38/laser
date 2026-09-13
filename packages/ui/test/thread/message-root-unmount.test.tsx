// @vitest-environment happy-dom
/**
 * Reading upwards in a long conversation once blanked the whole window.
 *
 * The bounded transcript unmounts many rows in one commit as the window
 * moves. `MessagePrimitive.Root` reports "not hovering" into the thread's
 * state from its ref cleanup, so hundreds of rows leaving at once meant
 * hundreds of state dispatches inside one cleanup phase — past React's
 * nested-update limit, which throws and, with nothing catching it, unmounted
 * the app. That cascade only trips under a real browser's scheduling, so the
 * regression lives in `scripts/browser-check/test/scroll-up-blank.mjs`. This
 * pins the contract that makes the fix hold: our row root is a plain element
 * that carries the message id the viewport looks up and nothing else.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MessageRoot } from "../../src/components/thread/messages.js";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const convert = (message: ThreadMessageLike) => message;
const Row = () => <MessageRoot data-testid="row" className="group/message">row</MessageRoot>;
function Fixture({ count }: { count: number }) {
  const messages: ThreadMessageLike[] = Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? "assistant" : "user", content: `Row ${i}` }));
  const runtime = useExternalStoreRuntime({ messages, convertMessage: convert, isRunning: false, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root><ThreadPrimitive.Viewport><ThreadPrimitive.Messages components={{ Message: Row }} /></ThreadPrimitive.Viewport></ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

it("is a plain element with the message id and the caller's attributes, and leaves the window without a trace", async () => {
  await act(async () => root.render(<Fixture count={3} />));
  const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="row"]')];
  expect(rows.map(row => row.getAttribute("data-message-id"))).toEqual(["m-0", "m-1", "m-2"]);
  expect(rows[0]?.tagName).toBe("DIV");
  expect(rows[0]?.className).toBe("group/message");
  // Pointer over a row, then the row leaves: nothing to clean up, nothing thrown.
  rows[1]?.dispatchEvent(new MouseEvent("mouseenter"));
  await act(async () => root.render(<Fixture count={1} />));
  expect(host.querySelectorAll('[data-testid="row"]').length).toBe(1);
  expect(host.textContent).toBe("row");
});
