// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { systemDirection, logicalSide, logicalArrowKey } from "../src/theme/direction.js";
import { themeStore, DEFAULT_STATE } from "../src/theme/store.js";
import { readBootBlob } from "../src/theme/apply.js";
import { Segmented } from "../src/components/settings/appearance/controls.js";
import { useTheme } from "../src/theme/use-theme.js";

afterEach(() => { themeStore.reset(); vi.restoreAllMocks(); });

it.each([ ["ar", "rtl"], ["he-IL", "rtl"], ["fa", "rtl"], ["ur", "rtl"], ["az-Arab", "rtl"], ["ar-Latn", "ltr"], ["en", "ltr"], ["invalid_locale", "ltr"] ])("resolves %s as %s", (language, expected) => {
  expect(systemDirection(language)).toBe(expected);
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
    await act(async () => buttons[1]!.click());
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
