// @vitest-environment happy-dom
import { instructionTemplateIssue } from "@lasercode/protocol";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstructionTemplateEditor, InstructionTemplateSourceView } from "../../../src/components/agents/page/InstructionTemplateEditor.js";
import { instructionSyntaxRanges } from "../../../src/components/agents/page/InstructionTemplateSource.js";
import {
  instructionTemplateValue,
  instructionTemplateVariables,
  type InstructionTemplateValueContext,
} from "../../../src/components/agents/page/instruction-template-model.js";

const context: InstructionTemplateValueContext = {
  agentName: "reviewer",
  agentDescription: "Reviews every changed file",
  model: { provider: "openai", id: "gpt-5" },
  thinkingLevel: "high",
  provenance: "Current draft",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.requestAnimationFrame === "undefined") {
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0) as unknown as number;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const click = (element: Element) => act(async () => (element as HTMLElement).click());
const escape = () => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
const settle = (ms = 40) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const button = (label: string) => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};

function EditorHarness({ initial, maxLength = 4096 }: { initial: string; maxLength?: number }) {
  const [value, setValue] = useState(initial);
  return <InstructionTemplateEditor target="agent" context={context} value={value} maxLength={maxLength} ariaLabel="Agent instructions" onChange={setValue} />;
}

describe("instruction template source", () => {
  it("recognizes the protocol's spaced and triple field forms without making unknown or malformed fields valid", () => {
    const source = "{{ agentName }} / {{{productName}}} / {{madeUp}} / {{agentName";
    const variables = instructionTemplateVariables(source, "agent");
    expect(variables.map((variable) => [variable.token, variable.field?.key])).toEqual([
      ["{{ agentName }}", "agentName"],
      ["{{{productName}}}", "productName"],
      ["{{madeUp}}", undefined],
    ]);
    expect(instructionTemplateIssue("{{ agentName }} / {{{productName}}}", "agent")).toBeNull();
    expect(instructionTemplateIssue("{{madeUp}}", "agent")).toContain("not available");
    expect(instructionTemplateIssue("{{agentName", "agent")).toContain("incomplete");
  });

  it("reports editor-known values separately from values that only exist during a run", () => {
    expect(instructionTemplateValue("agentName", context)).toEqual({ status: "known", value: "reviewer", provenance: "Current draft" });
    expect(instructionTemplateValue("model", context)).toEqual({ status: "known", value: "openai/gpt-5", provenance: "Current draft" });
    expect(instructionTemplateValue("agentDescription", { ...context, agentDescription: "" })).toEqual({ status: "known", value: "", provenance: "Current draft" });
    expect(instructionTemplateValue("availableTools", context)).toMatchObject({ status: "runtime", reason: expect.stringContaining("session") });
    expect(instructionTemplateValue("workingDirectory", context)).toMatchObject({ status: "runtime", reason: expect.stringContaining("worktree") });
  });

  it("uses Shiki ranges only when a line round-trips to the original source", () => {
    const source = "# Title\nplain";
    const ranges = instructionSyntaxRanges(source, [
      [{ content: "#", color: "var(--syntax-punctuation)" }, { content: " Title", color: "var(--syntax-function)" }],
      [{ content: "changed", color: "var(--danger)" }],
    ]);
    expect(ranges.map((range) => source.slice(range.start, range.end))).toEqual(["#", " Title"]);
  });

  it("preserves exact Markdown source and opens known and run-only variables", async () => {
    const source = "# Review\n\nUse {{ agentName }}.\n\n{{availableTools}}";
    await act(async () => root.render(<EditorHarness initial={source} />));
    await click(button("Highlighted source"));
    await settle(200);

    const view = container.querySelector<HTMLElement>('[data-slot="instruction-template-source"]')!;
    expect(view.querySelector("code")?.textContent).toBe(source);
    expect(container.querySelector('[data-field="madeUp"]')).toBeNull();

    await click(container.querySelector('[data-field="agentName"]')!);
    expect(document.body.querySelector('[data-slot="instruction-template-current-value"]')?.textContent).toBe("reviewer");
    expect(document.body.textContent).toContain("Current draft");
    await escape();
    await settle();

    await click(container.querySelector('[data-field="availableTools"]')!);
    expect(document.body.querySelector('[data-slot="instruction-template-runtime-value"]')?.textContent).toContain("Resolved when the agent runs");
    expect(document.body.textContent).toContain("active tool list");
  });

  it("restores the caret and edit focus when inserting from highlighted source", async () => {
    await act(async () => root.render(<EditorHarness initial="Head tail" />));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(4, 4);

    await click(button("Highlighted source"));
    expect(container.querySelector("textarea")).toBeNull();
    await click(button("Insert field"));
    const product = [...document.body.querySelectorAll<HTMLButtonElement>('[role="listitem"]')].find((candidate) => candidate.textContent?.includes("Product name"))!;
    await click(product);
    await settle();

    const restored = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(restored.value).toBe("Head{{productName}} tail");
    expect(document.activeElement).toBe(restored);
    expect(restored.selectionStart).toBe("Head{{productName}}".length);
    expect(restored.selectionEnd).toBe(restored.selectionStart);
  });

  it("does not let field insertion exceed the textarea limit", async () => {
    await act(async () => root.render(<EditorHarness initial="full" maxLength={4} />));
    await click(button("Insert field"));
    const product = [...document.body.querySelectorAll<HTMLButtonElement>('[role="listitem"]')].find((candidate) => candidate.textContent?.includes("Product name"))!;
    expect(product.disabled).toBe(true);
    expect(product.textContent).toContain("Not enough room");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("full");
  });

  it("shares the viewer with a read-only default surface without edit controls", async () => {
    const source = "# Default\n\n{{productName}}";
    await act(async () => root.render(<InstructionTemplateSourceView target="agent" value={source} context={context} ariaLabel="Default highlighted source" />));
    await settle(200);
    expect(container.querySelector('[data-slot="instruction-template-source"] code')?.textContent).toBe(source);
    expect(container.querySelector('[data-field="productName"]')).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[aria-label="Instruction view"]')).toBeNull();
  });
});
