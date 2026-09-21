// @vitest-environment happy-dom
/**
 * Appearance → the custom token editor (M11-T4, M11-T7), pinned.
 *
 * This suite exists because the row underneath this editor is now shared with
 * Foundation mode's token editor (M21-T14 follow-up). What Settings does must
 * not move a millimetre when a second surface starts using the same row, so
 * every behaviour a person relies on here is asserted directly: the swatch and
 * the field carry the *raw* value, an optional token that nobody pinned shows
 * the derived value and says so, "Derived" unpins it, the contrast readout
 * measures the value typed rather than the one the compiler would rescue, and
 * a half-typed colour changes nothing while it is being typed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenEditor } from "../../src/components/settings/appearance/TokenEditor.js";
import { PRESETS, type Theme } from "../../src/theme/index.js";

let root: Root;
let container: HTMLDivElement;

function theme(over: Partial<Theme["tokens"]> = {}): Theme {
  const preset = PRESETS[0]!;
  const { tagline: _tagline, ...rest } = preset;
  return { ...rest, id: "custom", tokens: { ...preset.tokens, ...over } };
}

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

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

const field = (label: string): HTMLInputElement | null => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

const type = async (input: HTMLInputElement | null, value: string): Promise<void> => {
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** The row a token is drawn in, whatever the markup around it is. */
function row(token: string): HTMLElement {
  const label = field(`${token} value`);
  expect(label, `a row for ${token}`).not.toBeNull();
  return label!.closest("div")!;
}

describe("the rows", () => {
  it("draws every required colour with its own swatch and value", async () => {
    const current = theme({ ink: "#111111", bg: "#ffffff" });
    await render(<TokenEditor theme={current} issues={[]} onSet={vi.fn()} onClear={vi.fn()} />);
    expect(field("ink value")?.value).toBe("#111111");
    expect(field("bg value")?.value).toBe("#ffffff");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="ink colour"]')?.type).toBe("color");
  });

  it("pushes a parsed value up and leaves a half-typed one alone", async () => {
    const onSet = vi.fn();
    await render(<TokenEditor theme={theme()} issues={[]} onSet={onSet} onClear={vi.fn()} />);
    await type(field("ink value"), "#12");
    expect(onSet).not.toHaveBeenCalled();
    // The field keeps what is being typed rather than snapping back.
    expect(field("ink value")?.value).toBe("#12");
    expect(field("ink value")?.getAttribute("aria-invalid")).toBe("true");
    await type(field("ink value"), "#123456");
    expect(onSet).toHaveBeenCalledWith("ink", "#123456");
    expect(field("ink value")?.getAttribute("aria-invalid")).toBe("false");
  });

  it("measures the value typed, and names what it is unreadable on", async () => {
    // Ink one shade off its ground: the readout is of the number typed, not
    // of the one the contrast guard would rescue it to.
    const current = theme({ bg: "#ffffff", surface: "#ffffff", "surface-2": "#ffffff", ink: "#f0f0f0" });
    await render(<TokenEditor theme={current} issues={[]} onSet={vi.fn()} onClear={vi.fn()} />);
    expect(row("ink").textContent).toContain("unreadable on");
    expect(row("ink").textContent).toMatch(/1\.\d{2}:1/);
    const readable = theme({ bg: "#ffffff", surface: "#ffffff", "surface-2": "#ffffff", ink: "#111111" });
    await render(<TokenEditor theme={readable} issues={[]} onSet={vi.fn()} onClear={vi.fn()} />);
    expect(row("ink").textContent).toContain("on bg");
    expect(row("ink").textContent).not.toContain("unreadable");
  });

  it("shows an unpinned optional token as derived, and pins it when it is edited", async () => {
    const onSet = vi.fn();
    const { "on-live": _pinned, ...tokens } = theme().tokens;
    const current = { ...theme(), tokens } as Theme;
    await render(<TokenEditor theme={current} issues={[]} onSet={onSet} onClear={vi.fn()} />);
    // Optional tokens live behind the advanced disclosure; open it.
    const trigger = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("Terminal, syntax and derived colours"));
    await act(async () => trigger!.click());
    expect(row("on-live").textContent).toContain("derived");
    // Nothing offers "Derived" back while it is derived already.
    expect([...row("on-live").querySelectorAll("button")].some((node) => node.textContent?.includes("Derived"))).toBe(false);
    await type(field("on-live value"), "#654321");
    expect(onSet).toHaveBeenCalledWith("on-live", "#654321");
  });

  it("unpins a pinned optional token through its own button", async () => {
    const onClear = vi.fn();
    await render(<TokenEditor theme={theme({ "on-live": "#010203" })} issues={[]} onSet={vi.fn()} onClear={onClear} />);
    const trigger = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("Terminal, syntax and derived colours"));
    await act(async () => trigger!.click());
    expect(row("on-live").textContent).not.toContain("derived");
    const derived = [...row("on-live").querySelectorAll("button")].find((node) => node.textContent?.includes("Derived"));
    expect(derived, "a pinned optional token offers the derived value back").toBeDefined();
    await act(async () => (derived as HTMLButtonElement).click());
    expect(onClear).toHaveBeenCalledWith("on-live");
  });

  it("never offers to unpin a required token", async () => {
    await render(<TokenEditor theme={theme()} issues={[]} onSet={vi.fn()} onClear={vi.fn()} />);
    expect([...row("ink").querySelectorAll("button")].some((node) => node.textContent?.includes("Derived"))).toBe(false);
  });

  it("lists the issues that keep a theme from being applied", async () => {
    await render(
      <TokenEditor
        theme={theme()}
        issues={[{ token: "ink", level: "error", message: "ink is unreadable on surface." }]}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("ink is unreadable on surface.");
    expect(container.textContent).toContain("keeps this theme from being applied");
  });
});
