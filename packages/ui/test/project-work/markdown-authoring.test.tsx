// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MarkdownAuthoringField,
  MarkdownEditorActivationProvider,
} from "../../src/components/project-work/MarkdownAuthoringField.js";
import { MarkdownSourceEditor } from "../../src/components/project-work/MarkdownSourceEditor.js";
import { MarkdownListField } from "../../src/components/project-work/bodies/editor-fields.js";

let root: Root;
let container: HTMLDivElement;

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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function editorView(): EditorView {
  const content = container.querySelector<HTMLElement>(".cm-content");
  expect(content).not.toBeNull();
  const view = EditorView.findFromDOM(content!);
  expect(view).not.toBeNull();
  return view!;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(label));
  expect(found).toBeDefined();
  return found!;
}

describe("the real Markdown source editor", () => {
  it("labels the editable content, lets Tab escape, and becomes truly read-only", async () => {
    const onChange = vi.fn();
    const onCreateShortcut = vi.fn();
    await act(async () => root.render(<MarkdownSourceEditor value="**Draft** مرحبا" onChange={onChange} label="Brief" describedBy="brief-help" onCreateShortcut={onCreateShortcut} />));
    await settle();

    const content = container.querySelector<HTMLElement>(".cm-content")!;
    expect(content.getAttribute("aria-label")).toBe("Brief");
    expect(content.getAttribute("aria-describedby")).toBe("brief-help");
    expect(content.getAttribute("contenteditable")).toBe("true");

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    content.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(editorView().state.doc.toString()).toBe("**Draft** مرحبا");

    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
    expect(onCreateShortcut).not.toHaveBeenCalled();
    const create = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    content.dispatchEvent(create);
    expect(create.defaultPrevented).toBe(true);
    expect(onCreateShortcut).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<MarkdownSourceEditor value="**Draft** مرحبا" onChange={onChange} label="Brief" describedBy="brief-help" onCreateShortcut={onCreateShortcut} readOnly />));
    expect(container.querySelector<HTMLElement>(".cm-content")?.getAttribute("contenteditable")).toBe("false");
  });

  it("rejects an over-limit transaction before the visible document can diverge from Preview", async () => {
    function Harness() {
      const [value, setValue] = useState("1234");
      return <MarkdownAuthoringField label="Brief" value={value} maxLength={5} onChange={setValue} />;
    }

    await act(async () => root.render(<Harness />));
    await settle();
    const view = editorView();

    await act(async () => view.dispatch({ changes: { from: 4, insert: "5" } }));
    expect(view.state.doc.toString()).toBe("12345");
    await act(async () => view.dispatch({ changes: { from: 5, insert: "6" } }));
    expect(view.state.doc.toString()).toBe("12345");

    await act(async () => button("Preview").click());
    expect(container.textContent).toContain("12345");
    expect(container.textContent).not.toContain("123456");
  });
});

describe("bounded Markdown authoring", () => {
  function Fields({ active }: { active: boolean }) {
    const [first, setFirst] = useState("first");
    // Spec requirements may hold 256 rows; the view count must not follow it.
    const rows = Array.from({ length: 256 }, (_, index) => `Row ${String(index + 1)}`);
    return (
      <MarkdownEditorActivationProvider active={active}>
        {rows.map((label, index) => (
          <MarkdownAuthoringField key={label} label={label} value={index === 0 ? first : ""} onChange={index === 0 ? setFirst : () => {}} />
        ))}
      </MarkdownEditorActivationProvider>
    );
  }

  it("focuses the real editor after Edit source replaces its focused button", async () => {
    function TwoFields() {
      const [first, setFirst] = useState("first");
      const [second, setSecond] = useState("second");
      return (
        <MarkdownEditorActivationProvider active>
          <MarkdownAuthoringField editorKey="first" label="First" value={first} onChange={setFirst} />
          <MarkdownAuthoringField editorKey="second" label="Second" value={second} onChange={setSecond} />
        </MarkdownEditorActivationProvider>
      );
    }

    await act(async () => root.render(<TwoFields />));
    await settle();
    const editSecond = button("Edit source");
    editSecond.focus();
    expect(document.activeElement).toBe(editSecond);
    await act(async () => editSecond.click());
    await settle();

    const content = container.querySelector<HTMLElement>('.cm-content[aria-label="Second"]');
    expect(content).not.toBeNull();
    expect(document.activeElement).toBe(content);
  });

  it("keeps an active prose row's editor identity when an earlier row is removed", async () => {
    function List() {
      const [values, setValues] = useState(["first", "second", "third"]);
      return (
        <MarkdownEditorActivationProvider active>
          <MarkdownListField editorKey="rows" label="Rows" values={values} onChange={setValues} placeholder="row" addLabel="Add row" />
        </MarkdownEditorActivationProvider>
      );
    }
    await act(async () => root.render(<List />));
    await settle();
    const editSecond = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("Edit source"));
    expect(editSecond).toBeDefined();
    await act(async () => editSecond!.click());
    await settle();
    const second = container.querySelector<HTMLElement>('.cm-content[aria-label="Rows 2"]')!;
    const view = EditorView.findFromDOM(second);
    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" }, selection: { anchor: 2 } }));
    const removeFirst = container.querySelector<HTMLButtonElement>('button[aria-label="Remove rows 1"]')!;
    await act(async () => removeFirst.click());
    const moved = container.querySelector<HTMLElement>('.cm-content[aria-label="Rows 1"]');
    expect(moved).toBe(second);
    expect(EditorView.findFromDOM(moved!).state.doc.toString()).toBe("second!");
    expect(EditorView.findFromDOM(moved!).state.selection.main.head).toBe(2);
  });

  it("mounts one editor at a schema-limit row count and retains its selection and undo across kind visibility", async () => {
    await act(async () => root.render(<Fields active />));
    await settle();
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);

    const firstContent = container.querySelector<HTMLElement>(".cm-content")!;
    const firstView = editorView();
    await act(async () => firstView.dispatch({ selection: { anchor: 2 }, changes: { from: 5, insert: "!" } }));
    expect(firstView.state.doc.toString()).toBe("first!");

    await act(async () => root.render(<Fields active={false} />));
    await act(async () => root.render(<Fields active />));
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(container.querySelector<HTMLElement>(".cm-content")).toBe(firstContent);
    expect(editorView().state.selection.main.head).toBe(2);

    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => container.querySelector<HTMLElement>(".cm-content")!.dispatchEvent(undo));
    expect(undo.defaultPrevented).toBe(true);
    expect(editorView().state.doc.toString()).toBe("first");
  });
});
