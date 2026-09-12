// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { systemDirection, logicalSide, logicalArrowKey } from "../src/theme/direction.js";
import { themeStore, DEFAULT_STATE } from "../src/theme/store.js";
import { readBootBlob } from "../src/theme/apply.js";
import { Segmented } from "../src/components/settings/appearance/controls.js";
import { useTheme } from "../src/theme/use-theme.js";
import { MessageBranches } from "../src/components/assistant-ui/elements/message-branches.js";
import { ConversationMap } from "../src/components/assistant-ui/elements/conversation-map.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { CanvasSplitDivider } from "../src/components/assistant-ui/elements/canvas-split.js";

afterEach(() => { themeStore.reset(); vi.restoreAllMocks(); });

it.each([ ["ar", "rtl"], ["he-IL", "rtl"], ["fa", "rtl"], ["ur", "rtl"], ["az-Arab", "rtl"], ["ar-Latn", "ltr"], ["en", "ltr"], ["invalid_locale", "ltr"] ])("resolves %s as %s", (language, expected) => {
  expect(systemDirection(language)).toBe(expected);
});

it("follows language changes only while the system choice is active", () => {
  const language = vi.spyOn(navigator, "language", "get").mockReturnValue("ar");
  const unsubscribe = themeStore.subscribe(() => {});
  try {
    themeStore.setTextDirection("system");
    expect(document.documentElement.dir).toBe("rtl");
    language.mockReturnValue("en");
    window.dispatchEvent(new Event("languagechange"));
    expect(document.documentElement.dir).toBe("ltr");
    themeStore.setTextDirection("rtl");
    window.dispatchEvent(new Event("languagechange"));
    expect(document.documentElement.dir).toBe("rtl");
  } finally { unsubscribe(); }
});

it("restores old appearance preferences and rejects invalid directions", () => {
  const { textDirection: _, ...old } = DEFAULT_STATE;
  themeStore.setTextDirection("rtl");
  expect(themeStore.hydrate(old)).toBe(true);
  expect(themeStore.getState().textDirection).toBe("system");
  expect(themeStore.hydrate({ ...old, textDirection: "sideways" })).toBe(false);
});

it("applies and persists a radio choice without remounting the app", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  function Control() {
    const { textDirection, setTextDirection } = useTheme();
    return <Segmented label="Text direction" value={textDirection} onChange={setTextDirection} options={[
      { value: "system", label: "Follow system" }, { value: "ltr", label: "Left to right" }, { value: "rtl", label: "Right to left" },
    ]} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Control />));
    const buttons = container.querySelectorAll("button");
    await act(async () => buttons[2]!.click());
    expect(document.documentElement.dir).toBe("rtl");
    expect(readBootBlob()?.state).toMatchObject({ textDirection: "rtl" });
    expect(buttons[2]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.documentElement.dir).toBe("ltr");
    expect(container.querySelectorAll("button")[2]).toBe(buttons[2]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("maps sides and horizontal keys only once", () => {
  expect(logicalSide("right", "rtl")).toBe("left");
  expect(logicalSide("left", "rtl")).toBe("right");
  expect(logicalSide("top", "rtl")).toBe("top");
  expect(logicalSide("right", "ltr")).toBe("right");
  expect(logicalArrowKey("ArrowRight", "rtl")).toBe("ArrowLeft");
  expect(logicalArrowKey("ArrowLeft", "rtl")).toBe("ArrowRight");
  expect(logicalArrowKey("ArrowDown", "rtl")).toBe("ArrowDown");
});


it("navigates versions and map ticks with logical horizontal arrows", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  themeStore.setTextDirection("rtl");
  const change = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TooltipProvider>
      <MessageBranches index={1} count={3} onIndexChange={change} />
      <ConversationMap entries={[{ id: "a", title: "First" }, { id: "b", title: "Second" }]} activeId="a" />
    </TooltipProvider>));
    const previous = container.querySelector<HTMLButtonElement>('[aria-label="Previous version"]')!;
    await act(async () => previous.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(change).toHaveBeenLastCalledWith(2);
    await act(async () => previous.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(change).toHaveBeenLastCalledWith(0);
    const ticks = container.querySelectorAll<HTMLButtonElement>('[data-slot="conversation-map-tick"]');
    await act(async () => ticks[0]!.focus());
    await act(async () => ticks[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(ticks[1]);
    await act(async () => themeStore.setTextDirection("ltr"));
    await act(async () => ticks[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(ticks[0]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("resizes the end pane toward the physical right in RTL with pointer and keyboard", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  themeStore.setTextDirection("rtl");
  const change = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CanvasSplitDivider width={200} min={100} max={400} onChange={change} />));
    const divider = container.firstElementChild as HTMLElement;
    divider.setPointerCapture = vi.fn();
    await act(async () => divider.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, pointerId: 1, bubbles: true })));
    await act(async () => divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 140, pointerId: 1, bubbles: true })));
    expect(change).toHaveBeenLastCalledWith(240);
    await act(async () => divider.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true })));
    await act(async () => divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(change).toHaveBeenLastCalledWith(216);
    await act(async () => divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(change).toHaveBeenLastCalledWith(184);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
