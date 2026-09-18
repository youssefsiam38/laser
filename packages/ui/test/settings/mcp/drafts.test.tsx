// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MCP_KNOWN_SERVERS, type McpImportSource, type McpServerConfig } from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../../src/runtime/index.js", () => {
  const stable = { client: { request: mocks.request, subscribe: () => () => {} }, actions: { toast: vi.fn() } };
  return { useLaserStable: () => stable };
});

import { McpAddDialog } from "../../../src/components/settings/mcp/McpAddDialog.js";
import { McpImportDialog } from "../../../src/components/settings/mcp/McpImportDialog.js";
import type { ScopeDraft } from "../../../src/components/settings/ScopeDraftGuard.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { clickElement, field, findButton, renderInWorkbench as render, type as typeInto } from "./harness.js";

let root: Root;
let draft: ScopeDraft | undefined;
const reportDraft = (next: ScopeDraft | undefined) => { draft = next; };
const config: McpServerConfig = { name: "docs", label: "Docs", transport: { kind: "stdio", command: "docs-server" } };

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  draft = undefined;
  mocks.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "mcp/save") return { servers: [] };
    if (method === "mcp/import/apply") return { servers: [], imported: ["docs"] };
    throw new Error(`unexpected ${method}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const add = (props: Pick<React.ComponentProps<typeof McpAddDialog>, "mode" | "scope" | "entry" | "edit">) => (
  <TooltipProvider><McpAddDialog
    cwd="/project"
    open
    onOpenChange={() => {}}
    onDraftChange={reportDraft}
    onSaved={() => {}}
    {...props}
  /></TooltipProvider>
);

it("treats blank custom and unchanged edit forms as clean, including revert", async () => {
  ({ root } = await render(add({ mode: "new", scope: "global" })));
  expect(draft).toBeUndefined();
  expect(findButton("Add")?.disabled).toBe(true);

  await typeInto("Name it", "Docs");
  expect(draft).toBeDefined();
  expect(draft?.save).toBeUndefined();
  await typeInto("Command", "docs-server");
  expect(draft?.save).toBeTypeOf("function");
  await typeInto("Command", "");
  await typeInto("Name it", "");
  expect(draft).toBeUndefined();

  await act(async () => root.unmount());
  ({ root } = await render(add({ mode: "edit", scope: "global", edit: { scope: "global", config } })));
  expect(draft).toBeUndefined();
  expect(findButton("Save changes")?.disabled).toBe(true);
});

it("treats gallery and Project override intents as deliberate, valid drafts", async () => {
  ({ root } = await render(add({ mode: "gallery", scope: "global", entry: MCP_KNOWN_SERVERS[0]! })));
  expect(draft?.save).toBeTypeOf("function");
  expect(findButton("Add")?.disabled).toBe(false);

  await act(async () => root.unmount());
  ({ root } = await render(add({ mode: "override", scope: "project", edit: { scope: "global", config } })));
  expect(draft?.save).toBeTypeOf("function");
  expect(findButton("Save Project override")?.disabled).toBe(false);
  await act(async () => { expect(await draft!.save!()).toBe(true); });
  expect(mocks.request).toHaveBeenCalledWith("mcp/save", {
    cwd: "/project",
    scope: "project",
    server: expect.objectContaining({ name: "docs" }),
  });
});

it("registers an import draft only after a meaningful selection", async () => {
  const sources: McpImportSource[] = [{
    id: "claude-code",
    label: "Claude Code",
    path: "/tmp/claude.json",
    servers: [{ name: "docs", config, conflicts: [], inlineSecrets: [] }],
  }];
  ({ root } = await render(
    <TooltipProvider><McpImportDialog
      cwd="/project"
      open
      onOpenChange={() => {}}
      sources={sources}
      scope="project"
      onDraftChange={reportDraft}
      onImported={() => {}}
    /></TooltipProvider>,
  ));
  expect(draft).toBeUndefined();
  await clickElement(field("Import docs") as HTMLInputElement);
  expect(draft?.save).toBeTypeOf("function");
  await clickElement(field("Import docs") as HTMLInputElement);
  expect(draft).toBeUndefined();
});
