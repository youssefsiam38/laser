// @vitest-environment happy-dom
/**
 * The shared tab / segmented control (`components/ui/tabs.tsx`): the product's
 * one idiom and the keyboard behind it. Pointer and keyboard, through the DOM,
 * on both roles — a tablist (navigation) and a radiogroup (a value).
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SegmentedControl, Tabs, type TabOption } from "../../src/components/ui/tabs.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Kind = "chat" | "code" | "logs";
const OPTIONS: TabOption<Kind>[] = [
  { value: "chat", label: "Chat", count: 2, id: "tab-chat", controls: "panel" },
  { value: "code", label: "Code", count: 17, id: "tab-code", controls: "panel" },
  { value: "logs", label: "Logs", id: "tab-logs", controls: "panel" },
];

function Host({ initial = "chat", onChange, options = OPTIONS, disabled = false }: {
  initial?: Kind;
  onChange?: (value: Kind) => void;
  options?: TabOption<Kind>[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState<Kind>(initial);
  return (
    <Tabs
      label="Kind"
      value={value}
      options={options}
      disabled={disabled}
      onChange={(next) => { onChange?.(next); setValue(next); }}
    />
  );
}

const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tab = (value: Kind) => container.querySelector<HTMLButtonElement>(`[role="tab"][data-option="${value}"]`)!;
const key = (node: HTMLElement, name: string) =>
  act(async () => { node.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });

describe("the tab idiom", () => {
  it("names the selected tab with ink and a rule, and leaves the others quiet", async () => {
    await act(async () => root.render(<Host />));
    const chat = tab("chat");
    const code = tab("code");

    expect(chat.getAttribute("aria-selected")).toBe("true");
    expect(code.getAttribute("aria-selected")).toBe("false");
    // The idiom: no track behind the row, no filled pill, no float shadow on a
    // flat panel — one ink rule under the tab you are on.
    const strip = container.querySelector('[data-slot="tabs"]')!;
    expect(strip.className).not.toContain("bg-surface-2");
    expect(strip.className).toContain("hairline-b");
    expect(chat.className).not.toContain("shadow-float");
    expect(chat.className).toContain("text-ink");
    expect(code.className).toContain("text-ink-2");
    const rule = (node: HTMLElement) => node.querySelector<HTMLElement>('[data-slot="tab-rule"]')!;
    expect(rule(chat).className).toContain("bg-ink");
    expect(rule(chat).className).toContain("opacity-100");
    expect(rule(code).className).toContain("opacity-0");

    // A count is a tabular figure at the 12px floor, never smaller than the
    // label, and an honest zero is drawn like any other number.
    const count = chat.querySelector<HTMLElement>('[data-slot="tab-count"]')!;
    expect(count.textContent).toBe("2");
    expect(count.className).toContain("typed");
    expect(tab("logs").querySelector('[data-slot="tab-count"]')).toBeNull();
    expect(tabs().every((node) => node.className.includes("pointer-coarse:min-h-11"))).toBe(true);
  });

  it("renders a four-digit count as 999+ rather than overflowing the strip", async () => {
    await act(async () => root.render(<Host options={[{ value: "chat", label: "Chat", count: 0 }, { value: "code", label: "Code", count: 1200 }]} />));
    expect(tab("chat").querySelector('[data-slot="tab-count"]')?.textContent).toBe("0");
    expect(tab("code").querySelector('[data-slot="tab-count"]')?.textContent).toBe("999+");
  });

  it("selects with a pointer and reports the new value once", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Host onChange={onChange} />));
    await act(async () => tab("code").click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("code");
    expect(tab("code").getAttribute("aria-selected")).toBe("true");
    // Clicking the tab that is already selected changes nothing.
    await act(async () => tab("code").click());
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("is one tab stop, and arrows, Home and End move the selection and the focus", async () => {
    await act(async () => root.render(<Host />));
    expect(tabs().map((node) => node.tabIndex)).toEqual([0, -1, -1]);

    tab("chat").focus();
    await key(tab("chat"), "ArrowRight");
    expect(tab("code").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("code"));
    expect(tabs().map((node) => node.tabIndex)).toEqual([-1, 0, -1]);

    await key(tab("code"), "ArrowLeft");
    expect(document.activeElement).toBe(tab("chat"));
    expect(tab("chat").getAttribute("aria-selected")).toBe("true");

    // Wrapping, the way a radio group and APG's tabs both wrap.
    await key(tab("chat"), "ArrowLeft");
    expect(document.activeElement).toBe(tab("logs"));
    expect(tab("logs").getAttribute("aria-selected")).toBe("true");

    await key(tab("logs"), "Home");
    expect(document.activeElement).toBe(tab("chat"));
    await key(tab("chat"), "End");
    expect(document.activeElement).toBe(tab("logs"));

    // The vertical axis moves the same way, for a strip read as a list.
    await key(tab("logs"), "ArrowDown");
    expect(document.activeElement).toBe(tab("chat"));
    await key(tab("chat"), "ArrowUp");
    expect(document.activeElement).toBe(tab("logs"));
  });

  it("steps over a disabled option and never lands on one", async () => {
    const options: TabOption<Kind>[] = [
      { value: "chat", label: "Chat" },
      { value: "code", label: "Code", disabled: true },
      { value: "logs", label: "Logs" },
    ];
    await act(async () => root.render(<Host options={options} />));
    tab("chat").focus();
    await key(tab("chat"), "ArrowRight");
    expect(document.activeElement).toBe(tab("logs"));
    expect(tab("logs").getAttribute("aria-selected")).toBe("true");
    await key(tab("logs"), "End");
    expect(document.activeElement).toBe(tab("logs"));
    expect(tab("code").disabled).toBe(true);
  });

  it("stays reachable when nothing is chosen yet", async () => {
    // The trust pair's case: a value outside the options means no option is
    // selected, and the first one still has to hold the group's tab stop.
    await act(async () => root.render(<Host initial={"" as Kind} />));
    expect(tabs().map((node) => node.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);
    expect(tabs().map((node) => node.tabIndex)).toEqual([0, -1, -1]);
    tab("chat").focus();
    await key(tab("chat"), "ArrowRight");
    expect(tab("code").getAttribute("aria-selected")).toBe("true");
  });

  it("stays readable but inert when the whole group is disabled", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Host disabled onChange={onChange} />));
    expect(container.querySelector('[data-slot="tabs"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(tabs().map((node) => node.tabIndex)).toEqual([-1, -1, -1]);
    await key(tab("chat"), "ArrowRight");
    expect(onChange).not.toHaveBeenCalled();
    expect(tab("chat").getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the label in place when a trailing mark appears", async () => {
    await act(async () => root.render(<Host />));
    const before = tab("chat").querySelector('[data-slot="tab-label"]')!.textContent;
    await act(async () => root.render(
      <Host options={OPTIONS.map((option) => option.value === "chat" ? { ...option, mark: <span data-slot="probe-mark">!</span> } : option)} />,
    ));
    // The mark is its own block after the label and its count, so nothing a
    // person is reading moves when activity arrives.
    const label = tab("chat").querySelector('[data-slot="tab-label"]')!;
    expect(label.textContent).toBe(before);
    expect(label.querySelector('[data-slot="probe-mark"]')).toBeNull();
    expect(tab("chat").querySelector('[data-slot="tab-mark"] [data-slot="probe-mark"]')).not.toBeNull();
  });

  it("carries the panel wiring a tablist owes its panel", async () => {
    await act(async () => root.render(<Host />));
    expect(tab("chat").id).toBe("tab-chat");
    expect(tab("chat").getAttribute("aria-controls")).toBe("panel");
    expect(container.querySelector('[data-slot="tabs"]')?.getAttribute("aria-label")).toBe("Kind");
  });
});

describe("the segmented control", () => {
  function Choice({ onChange }: { onChange?: (value: Kind) => void }) {
    const [value, setValue] = useState<Kind>("chat");
    return (
      <SegmentedControl
        label="Kind"
        value={value}
        options={OPTIONS.map(({ value: v, label }) => ({ value: v, label }))}
        onChange={(next) => { onChange?.(next); setValue(next); }}
      />
    );
  }

  it("is a radiogroup with the same idiom and the same keyboard", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Choice onChange={onChange} />));
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Kind");
    // A value in a row sits on the panel's own ground, with no hairline of its
    // own and no grey track.
    expect(group.className).not.toContain("hairline-b");
    expect(group.className).not.toContain("bg-surface-2");

    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await act(async () => radios[1]!.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("code");
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");

    radios[1]!.focus();
    await key(radios[1]!, "ArrowRight");
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2]!.getAttribute("aria-checked")).toBe("true");
    // The same nodes throughout: selection never remounts the row.
    expect([...container.querySelectorAll('[role="radio"]')]).toEqual(radios);
  });
});
