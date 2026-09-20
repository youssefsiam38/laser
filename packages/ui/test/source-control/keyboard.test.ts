// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { overlayKeyAction } from "../../src/source-control/keyboard.js";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

it("maps overlay keys for close, find, files, hunks, viewed, tabs and unified", () => {
  expect(overlayKeyAction(key({ key: "Escape" }))).toBe("close");
  expect(overlayKeyAction(key({ key: "f", ctrlKey: true }))).toBe("find");
  expect(overlayKeyAction(key({ key: "f", metaKey: true }))).toBe("find");
  expect(overlayKeyAction(key({ key: "ArrowDown" }))).toBe("next-file");
  expect(overlayKeyAction(key({ key: "j" }))).toBe("next-file");
  expect(overlayKeyAction(key({ key: "ArrowUp" }))).toBe("prev-file");
  expect(overlayKeyAction(key({ key: "k" }))).toBe("prev-file");
  expect(overlayKeyAction(key({ key: "]" }))).toBe("next-hunk");
  expect(overlayKeyAction(key({ key: "[" }))).toBe("prev-hunk");
  expect(overlayKeyAction(key({ key: "v" }))).toBe("toggle-viewed");
  expect(overlayKeyAction(key({ key: "u" }))).toBe("toggle-unified");
  expect(overlayKeyAction(key({ key: "Tab", ctrlKey: true }))).toBe("next-tab");
  expect(overlayKeyAction(key({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("prev-tab");
  expect(overlayKeyAction(key({ key: "w", ctrlKey: true }))).toBe("close-tab");
  expect(overlayKeyAction(key({ key: "b" }))).toBe("toggle-tree");
});

it("does not steal overlay keys while a git action dialog is open", () => {
  expect(overlayKeyAction(key({ key: "Escape" }), { gitActionOpen: true })).toBeUndefined();
  expect(overlayKeyAction(key({ key: "j" }), { gitActionOpen: true })).toBeUndefined();
  expect(overlayKeyAction(key({ key: "f", ctrlKey: true }), { gitActionOpen: true })).toBeUndefined();
});

it("does not steal file motion while typing in an input", () => {
  const input = document.createElement("input");
  document.body.append(input);
  const motion = key({ key: "j", bubbles: true });
  input.dispatchEvent(motion);
  expect(overlayKeyAction(motion)).toBeUndefined();
  const escape = key({ key: "Escape", bubbles: true });
  input.dispatchEvent(escape);
  expect(overlayKeyAction(escape)).toBe("close");
  const find = key({ key: "f", ctrlKey: true, bubbles: true });
  input.dispatchEvent(find);
  expect(overlayKeyAction(find)).toBe("find");
  input.remove();
});

it("lets arrows scroll a focused diff instead of changing file", () => {
  const scroller = document.createElement("div");
  scroller.dataset.slot = "changes-diff-scroll";
  scroller.tabIndex = 0;
  document.body.append(scroller);
  const down = key({ key: "ArrowDown", bubbles: true });
  scroller.dispatchEvent(down);
  expect(overlayKeyAction(down)).toBeUndefined();
  const up = key({ key: "ArrowUp", bubbles: true });
  scroller.dispatchEvent(up);
  expect(overlayKeyAction(up)).toBeUndefined();
  const next = key({ key: "j", bubbles: true });
  scroller.dispatchEvent(next);
  expect(overlayKeyAction(next)).toBe("next-file");
  scroller.remove();
});
