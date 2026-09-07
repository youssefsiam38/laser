// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSessionSeen } from "../../src/components/thread/use-session-seen.js";

it("acknowledges only the visible focused transcript, including pending approvals", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let focused = true;
  const focus = vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const markSeen = vi.fn();
  const container = document.createElement("div"), root = createRoot(container);
  let props = { path: "/a", seq: 1, running: false, dialogs: "", ready: true, covered: false, markSeen };
  function Probe() { useSessionSeen(props); return null; }
  const render = async () => { await act(async () => root.render(<Probe />)); };
  try {
    await render(); expect(markSeen).toHaveBeenLastCalledWith("/a", 1, true);
    props = { ...props, covered: true, seq: 2 }; await render();
    expect(markSeen).toHaveBeenCalledTimes(1);
    props = { ...props, covered: false, running: true, dialogs: "approval" }; await render();
    expect(markSeen).toHaveBeenLastCalledWith("/a", 2, true);
    props = { ...props, seq: 3 }; await render();
    expect(markSeen).toHaveBeenCalledTimes(2); // no traffic per streamed token
    focused = false;
    props = { ...props, path: "/b", running: false }; await render();
    expect(markSeen).toHaveBeenCalledTimes(2);
    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(markSeen).toHaveBeenLastCalledWith("/b", 3, true);
    visibility.mockReturnValue("hidden");
    props = { ...props, seq: 4 }; await render();
    expect(markSeen).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(markSeen).toHaveBeenLastCalledWith("/b", 4, true);
  } finally { await act(async () => root.unmount()); focus.mockRestore(); visibility.mockRestore(); }
});
