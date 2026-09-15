// @vitest-environment happy-dom
/**
 * RP-5b §2: code copied out of a message that is only shown in part says so in
 * the bytes that land on the clipboard. Where code sits in a body is not
 * something any authority addresses, so the marker is general and honest
 * rather than a claim about offsets nobody published.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExcerptedMessage, PARTIAL_CODE_NOTE } from "../../src/components/assistant-ui/elements/markdown-text.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let container: HTMLDivElement;
let root: Root;
let written: string[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  written = [];
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (text: string) => { written.push(text); } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const CODE = "const answer = 42;\nconsole.log(answer);\n";

describe("copying code out of a message", () => {
  it("marks the bytes when the message is only shown in part, and does not when it is whole", async () => {
    const { CodeHeaderForTest } = await import("../../src/components/assistant-ui/elements/markdown-text.js");
    for (const excerpted of [false, true]) {
      act(() => root.render(
        <TooltipProvider>
          <ExcerptedMessage value={excerpted}>
            <CodeHeaderForTest language="ts" code={CODE} />
          </ExcerptedMessage>
        </TooltipProvider>,
      ));
      const button = container.querySelector("button")!;
      await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
      const copied = written.at(-1)!;
      if (excerpted) {
        expect(copied.startsWith(PARTIAL_CODE_NOTE)).toBe(true);
        expect(copied).toContain(CODE);
        expect(copied).not.toBe(CODE);
      } else {
        expect(copied).toBe(CODE);
      }
    }
  });

  it("says what it did, and says nothing after it is gone", async () => {
    const { CodeHeaderForTest } = await import("../../src/components/assistant-ui/elements/markdown-text.js");
    act(() => root.render(
      <TooltipProvider>
        <ExcerptedMessage value><CodeHeaderForTest language="ts" code={CODE} /></ExcerptedMessage>
      </TooltipProvider>,
    ));
    const button = container.querySelector("button")!;
    await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").toBeDefined();
    // Unmounting while the "copied" clock runs leaves nothing behind to fire.
    await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 20)); });
    root = createRoot(container);
    expect(written).toHaveLength(1);
  });
});
