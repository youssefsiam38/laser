// @vitest-environment happy-dom
/**
 * A Laser tool's failure and its preview, in the transcript (M26-T4,
 * `docs/agent-tool-contract.md` §2, decision D-359.a).
 *
 * The error fixtures are built with the protocol's own `renderToolError`, so
 * what the rows are asserted against is exactly the text a failing tool throws
 * — not a hand-typed copy of it that could drift from the renderer.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";

import { renderToolError, toolError } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { ToolPreviewRow } from "../../src/components/thread/ToolPreviewRow.js";
import { readToolPreview, toolPreview } from "../../src/components/thread/tool-preview.js";
import { GitChangePreview } from "../../src/source-control/change-preview.js";

const preferences = vi.hoisted(() => ({ path: "/test/session", level: "everything" as string }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
  ...await import("../../src/runtime/projection.js"),
  useActivityDetailLevel: () => preferences.level,
  useLaserState: () => preferences.path,
  useLaserStable: () => ({ actions: { answerDialog: vi.fn(), send: vi.fn(async () => {}), openSession: vi.fn() } }),
  useLaserView: () => ({ dialogs: [] }),
}));
vi.mock("@/agents/hooks", () => ({ useSessionMcpServers: () => [] as readonly string[] }));
vi.mock("@assistant-ui/react", async (original) => ({
  ...await original<typeof import("@assistant-ui/react")>(),
  useToolCallElapsed: () => undefined,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  preferences.path = "/test/session";
  preferences.level = "everything";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Fixture(props: React.ComponentProps<typeof ToolRow>) {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <ToolRow {...props} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

const toolProps = (toolName: string, args: Record<string, unknown>, result: unknown, isError = false) =>
  ({
    toolCallId: `call-${toolName}`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    isError,
    status: { type: "complete" as const },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(async () => {}),
  }) as unknown as React.ComponentProps<typeof ToolRow>;

const renderRow = async (props: React.ComponentProps<typeof ToolRow>) => {
  await act(async () => root.render(<Fixture {...props} />));
};

/** A live tool result, as the engine hands one to the transcript. */
const toolResult = (text: string, details?: Record<string, unknown>) => ({
  content: [{ type: "text", text }],
  ...(details ? { details } : {}),
});

const NO_SUCH_RUN = toolError({
  code: "no_such_run",
  message: 'No run called "run_9" was started by this session.',
  committed: false,
  next: "call inspect_fleet to list the agents under you with their runIds.",
});

const PARTIAL_EXPORT = toolError({
  code: "export_interrupted",
  message: "The tracker accepted the first two items and then stopped answering.",
  committed: true,
  next: "call export_project_work again with the same idempotency key to finish it.",
});

const slot = (name: string) => container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const text = (node: Element | null | undefined) => node?.textContent ?? "";

// ---------------------------------------------------------------------------
// A failure that conforms to the contract
// ---------------------------------------------------------------------------

describe("a failed tool row under the contract", () => {
  it("leads with the message, says nothing was changed, and ends with the next step", async () => {
    await renderRow(toolProps("inspect_agent", { runId: "run_9" }, toolResult(renderToolError(NO_SUCH_RUN)), true));

    const report = slot("tool-error-report");
    expect(report).not.toBeNull();
    expect(text(slot("tool-error-message"))).toBe(NO_SUCH_RUN.message);
    expect(text(slot("tool-error-committed"))).toBe("Nothing was changed.");
    expect(text(slot("tool-error-next"))).toContain(NO_SUCH_RUN.next);
    expect(report?.getAttribute("data-committed")).toBe("false");
  });

  it("never uses the code as the headline, and keeps it as a typed chip", async () => {
    await renderRow(toolProps("inspect_agent", { runId: "run_9" }, toolResult(renderToolError(NO_SUCH_RUN)), true));

    const headline = slot("tool-error-message");
    expect(text(headline)).not.toContain("no_such_run");
    expect(text(headline)).not.toContain("[");
    const code = slot("tool-error-code");
    expect(text(code)).toBe("no_such_run");
    // The chip is typed (12px floor), never the sentence a person reads first.
    expect(code?.className).toContain("typed");
    // The three fixed lines are read back into fields, so the raw rendering
    // never appears as one block of text anywhere in the row.
    expect(container.textContent).not.toContain("[no_such_run]");
    expect(container.textContent).not.toContain("Next: call inspect_fleet");
  });

  it("marks work that survived the failure in the attention tone, and work that did not in the quiet danger tone", async () => {
    await renderRow(toolProps("export_project_work", { id: "SPEC-12" }, toolResult(renderToolError(PARTIAL_EXPORT)), true));
    const committed = slot("tool-error-committed");
    expect(text(committed)).toBe("Some of this was already saved.");
    expect(committed?.className).toContain("text-attention");
    expect(slot("tool-error-report")?.getAttribute("data-committed")).toBe("true");

    await renderRow(toolProps("inspect_agent", { runId: "run_9" }, toolResult(renderToolError(NO_SUCH_RUN)), true));
    const quiet = slot("tool-error-committed");
    expect(text(quiet)).toBe("Nothing was changed.");
    expect(quiet?.className).toContain("text-danger-quiet");
    // Two different facts, two different tones, neither one a hex literal.
    expect(quiet?.className).not.toContain("text-attention");
  });

  it("is announced as an alert", async () => {
    await renderRow(toolProps("inspect_agent", { runId: "run_9" }, toolResult(renderToolError(NO_SUCH_RUN)), true));
    expect(slot("tool-error-report")?.getAttribute("role")).toBe("alert");
  });

  it("shows the message and what was saved while the row is collapsed, and the next step only inside it", async () => {
    preferences.level = "answers";
    // A collapsed row peeks: an engine tool's row (`read`) has the peek slot.
    await renderRow(toolProps("read", { path: "/a/b.ts" }, toolResult(renderToolError(PARTIAL_EXPORT)), true));
    expect(text(slot("tool-error-message"))).toBe(PARTIAL_EXPORT.message);
    expect(text(slot("tool-error-committed"))).toBe("Some of this was already saved.");
    expect(slot("tool-error-next")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A failure that does not conform — engine tools, MCP tools, older captures
// ---------------------------------------------------------------------------

describe("a failure that is not under the contract", () => {
  /**
   * Proxy, named as one: "unchanged" is asserted as "the pre-existing
   * `tool-error` element draws it, with the text intact and no parsed report
   * anywhere" — the same element and the same text this row rendered before
   * M26-T4. It is not a pixel comparison.
   */
  const unchanged = (raw: string) => {
    expect(slot("tool-error-report")).toBeNull();
    const plain = slot("tool-error");
    expect(plain).not.toBeNull();
    expect(text(plain)).toContain(raw.split("\n")[0]);
  };

  it("draws an engine tool's failure exactly as before", async () => {
    const raw = "ENOENT: no such file or directory, open '/a/b.ts'";
    await renderRow(toolProps("read", { path: "/a/b.ts" }, toolResult(raw), true));
    unchanged(raw);
  });

  it("draws text that only looks like a tool error as the text it is", async () => {
    // A message with the code prefix but neither fixed sentence: not the
    // contract's shape, so nothing is guessed from prose.
    const raw = "[some_code] Something went wrong.\nMaybe it saved something?";
    await renderRow(toolProps("read", { path: "/a/b.ts" }, toolResult(raw), true));
    unchanged(raw);
    expect(container.textContent).toContain("[some_code]");
  });
});

// ---------------------------------------------------------------------------
// Preview rows
// ---------------------------------------------------------------------------

const PREVIEW_DETAILS = {
  preview: true,
  digest: "b8f0c1a4e93d5f17",
  summary: "Export SPEC-12 revision 4 to the tracker as a new issue.",
  target: "acme/atlas",
  items: ["SPEC-12", "TASK-44"],
  confirmWith: "export_project_work",
};

describe("a tool result that is a preview", () => {
  it("draws the person's preview card with the change, the digest and no confirm button", async () => {
    await renderRow(
      toolProps("export_project_work", { id: "SPEC-12", preview: true }, toolResult("preview", PREVIEW_DETAILS)),
    );

    const preview = slot("tool-preview");
    expect(preview).not.toBeNull();
    // The same card the commit/push/PR dialogs draw.
    expect(preview?.querySelector('[data-slot="change-preview"]')).not.toBeNull();
    expect(text(preview?.querySelector('[data-slot="change-preview-summary"]'))).toBe(PREVIEW_DETAILS.summary);
    expect(text(preview?.querySelector('[data-slot="change-preview-facts"]'))).toContain("acme/atlas");
    expect(text(preview?.querySelector('[data-slot="change-preview-items"]'))).toContain("TASK-44");
    expect(text(slot("tool-preview-digest"))).toBe(PREVIEW_DETAILS.digest);
    // Confirmation is the model's next call, not a control in the transcript.
    expect(preview?.querySelectorAll("button").length).toBe(0);
    expect(text(slot("tool-preview-confirm"))).toMatch(/asks again with this exact preview/i);
    expect(text(slot("tool-preview-confirm"))).toContain("export_project_work");
    expect(text(preview)).toMatch(/Nothing has happened yet/i);
  });

  it("carries a group role and a name, so it is reachable as one thing", async () => {
    await renderRow(
      toolProps("export_project_work", { id: "SPEC-12", preview: true }, toolResult("preview", PREVIEW_DETAILS)),
    );
    const preview = slot("tool-preview");
    expect(preview?.getAttribute("role")).toBe("group");
    expect(preview?.getAttribute("aria-label")).toBe("Preview of what this would do");
  });

  it("stays out of the fold, so a collapsed row still shows it", async () => {
    preferences.level = "answers";
    await renderRow(
      toolProps("export_project_work", { id: "SPEC-12", preview: true }, toolResult("preview", PREVIEW_DETAILS)),
    );
    expect(slot("tool-preview")).not.toBeNull();
    expect(text(slot("change-preview-summary"))).toBe(PREVIEW_DETAILS.summary);
  });

  it("is not drawn for an ordinary result", async () => {
    await renderRow(toolProps("export_project_work", { id: "SPEC-12" }, toolResult("Exported SPEC-12.")));
    expect(slot("tool-preview")).toBeNull();
  });

  it("draws the same card the git dialog draws", async () => {
    await act(async () =>
      root.render(
        <GitChangePreview
          confirmation={{ repo: "/w/app", branch: "main", remote: "origin", files: ["src/a.ts"], summary: "Commit one file on main." }}
        />,
      ),
    );
    expect(slot("change-preview")).not.toBeNull();
    expect(text(slot("change-preview-summary"))).toBe("Commit one file on main.");
    expect(text(slot("change-preview-facts"))).toContain("app");
    expect(text(slot("change-preview-items"))).toContain("src/a.ts");

    await act(async () =>
      root.render(<ToolPreviewRow preview={{ digest: "d".repeat(16), summary: "Would do the thing.", items: [] }} />),
    );
    expect(slot("change-preview")).not.toBeNull();
    expect(text(slot("change-preview-summary"))).toBe("Would do the thing.");
  });
});

// ---------------------------------------------------------------------------
// The detected shape (the contract producers must match)
// ---------------------------------------------------------------------------

describe("reading a preview payload", () => {
  it("reads it from the declared output, from the result itself, or from JSON text", () => {
    const expected = {
      digest: PREVIEW_DETAILS.digest,
      summary: PREVIEW_DETAILS.summary,
      target: "acme/atlas",
      confirmWith: "export_project_work",
      items: ["SPEC-12", "TASK-44"],
    };
    expect(toolPreview(toolResult("preview", PREVIEW_DETAILS))).toEqual(expected);
    expect(toolPreview(PREVIEW_DETAILS)).toEqual(expected);
    // The text path belongs to the tools that could have promised this shape.
    expect(toolPreview(toolResult(JSON.stringify(PREVIEW_DETAILS)), "export_project_work")).toBeUndefined();
    expect(toolPreview(toolResult(JSON.stringify(PREVIEW_DETAILS)), "remove_agent_worktree")).toEqual(expected);
  });

  // F-S2: a command's output is not a promise about the transcript.
  it("never reads a preview out of an engine or MCP tool's text", () => {
    const payload = JSON.stringify({ preview: true, digest: "b8f0c1a4e93d5f17", summary: "Export SPEC-12 to the tracker." });
    for (const tool of ["bash", "read", "edit", "mcp__tracker__create_issue", undefined]) {
      expect(toolPreview(toolResult(payload), tool), tool ?? "an unnamed row").toBeUndefined();
    }
    // The two strict paths are unchanged for every row: a declared output, or
    // the result object itself, is the producer saying so.
    expect(toolPreview(toolResult("done", { preview: true, digest: "b8f0c1a4e93d5f17", summary: "Export SPEC-12 to the tracker." }), "bash")?.summary).toBe(
      "Export SPEC-12 to the tracker.",
    );
  });

  it("needs `preview: true`, a digest and a sentence; anything else is an ordinary result", () => {
    expect(readToolPreview({ digest: "b8f0c1a4e93d5f17", summary: "x" })).toBeUndefined();
    expect(readToolPreview({ preview: "true", digest: "b8f0c1a4e93d5f17", summary: "x" })).toBeUndefined();
    expect(readToolPreview({ preview: true, summary: "x" })).toBeUndefined();
    expect(readToolPreview({ preview: true, digest: "b8f0c1a4e93d5f17" })).toBeUndefined();
    // A digest is opaque and bounded: not a path, not a sentence.
    expect(readToolPreview({ preview: true, digest: "/etc/passwd", summary: "x" })).toBeUndefined();
    expect(readToolPreview({ preview: true, digest: "short", summary: "x" })).toBeUndefined();
  });

  it("bounds what a payload can put on screen", () => {
    const read = readToolPreview({
      preview: true,
      digest: "b8f0c1a4e93d5f17",
      summary: "s".repeat(1000),
      target: 42,
      items: [...Array.from({ length: 500 }, (_, i) => `item-${i}`), 7, null],
    });
    expect(read?.summary.length).toBe(400);
    expect(read?.target).toBeUndefined();
    expect(read?.items.length).toBe(200);
  });

  it("does not hunt for a preview inside a large body", () => {
    const padding = JSON.stringify("pad") + ":1,";
    expect(toolPreview(toolResult(`{"preview":true,${padding.repeat(8000)}"digest":"b8f0c1a4e93d5f17"}`), "remove_agent_worktree")).toBeUndefined();
  });
});
