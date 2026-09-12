// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SyntaxHighlighter } from "../../src/components/assistant-ui/elements/shiki-highlighter.js";
import { shikiLanguageFromPath } from "../../src/components/assistant-ui/elements/shiki-language.js";

const trace = vi.hoisted(() => ({ loads: 0, calls: 0 }));
vi.mock("react-shiki", () => {
  trace.loads++;
  return { useShikiHighlighter: () => { trace.calls++; return null; } };
});

it("filename labels and streaming fences never load the highlighter; settlement does without changing the code", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  expect(shikiLanguageFromPath("file.tsx")).toBe("tsx");
  expect(trace.loads).toBe(0);
  const container = document.createElement("div"), root = createRoot(container);
  const code = "const message = '<script>not markup</script>';\n";
  try {
    await act(async () => root.render(<SyntaxHighlighter code={code} language="tsx" streaming />));
    expect(trace.loads).toBe(0);
    expect(container.textContent).toBe(code.trimEnd());
    expect(container.querySelector("script")).toBeNull();
    await act(async () => root.render(<SyntaxHighlighter code={code} language="tsx" />));
    await vi.waitFor(async () => { await act(async () => {}); expect(trace.calls).toBeGreaterThan(0); });
    expect(trace.loads).toBe(1);
    expect(container.textContent).toBe(code.trimEnd());
    expect(container.querySelector("script")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
