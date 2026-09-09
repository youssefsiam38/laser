// @vitest-environment happy-dom
/**
 * Extension dialogs live in the transcript (docs/ux-fleet.md, "Questions"):
 * inside the tool row that raised them when that row is on screen, and as a
 * card above the composer otherwise. Nothing is answerable only in a sheet,
 * and nothing that cannot be drawn is left hanging (AGENTS.md invariant 6).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiDialogRequest } from "@lasercode/protocol";

import { ThreadDialogCards, ToolRowDialog } from "../../src/dialogs/InlineDialogs.js";
import { dialogFormOf, isRenderableDialog, uiResponseFor } from "../../src/dialogs/model.js";
import { resetToolRows, useRegisterToolRow } from "../../src/dialogs/tool-rows.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const PATH = "/p/root.jsonl";

const fixture = vi.hoisted(() => ({
  dialogs: [] as unknown[],
  actions: { answerDialog: vi.fn(async () => undefined), toast: vi.fn() },
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserView: () => ({ path: PATH, dialogs: fixture.dialogs }),
  useLaserStable: () => ({ actions: fixture.actions }),
}));
vi.mock("@/pwa", () => ({ usePendingDecisionLink: () => undefined, consumeDecisionLink: () => {} }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetToolRows();
  fixture.dialogs = [];
  fixture.actions.answerDialog.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async (node: React.ReactNode): Promise<void> => {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
};

/** A tool row that declares itself on screen, exactly as `ToolRow` does. */
function MountedRow({ toolCallId }: { toolCallId: string }) {
  useRegisterToolRow(toolCallId);
  return <ToolRowDialog toolCallId={toolCallId} />;
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>("button")];

/** Type into a React-controlled field: the value tracker has to be told. */
const typeInto = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event("input", { bubbles: true })));
};
const press = async (label: string): Promise<void> => {
  const button = buttons().find((candidate) => candidate.textContent?.trim().startsWith(label));
  expect(button, `no control labelled ${label}`).toBeDefined();
  await act(async () => button!.click());
};

describe("questions in the transcript", () => {
  it("answers a select inline, as a card above the composer", async () => {
    fixture.dialogs = [{ id: "d1", method: "select", title: "Which branch?", options: ["main", "next"] } satisfies UiDialogRequest];
    await mount(<ThreadDialogCards />);
    const card = container.querySelector('[data-slot="dialog-card"]')!;
    expect(card.textContent).toContain("Which branch?");
    await press("next");
    expect(fixture.actions.answerDialog).toHaveBeenCalledWith({ id: "d1", value: "next" });
  });

  it("answers an input and an editor inline, with the prefill it was given", async () => {
    fixture.dialogs = [{ id: "d2", method: "input", title: "Name it", placeholder: "release name" } satisfies UiDialogRequest];
    await mount(<ThreadDialogCards />);
    await typeInto(container.querySelector<HTMLInputElement>("input")!, "v2");
    await press("Submit");
    expect(fixture.actions.answerDialog).toHaveBeenCalledWith({ id: "d2", value: "v2" });

    fixture.actions.answerDialog.mockClear();
    fixture.dialogs = [{ id: "d3", method: "editor", title: "The release note", prefill: "Fixes." } satisfies UiDialogRequest];
    await mount(<ThreadDialogCards />);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Fixes.");
    await press("Submit");
    expect(fixture.actions.answerDialog).toHaveBeenCalledWith({ id: "d3", value: "Fixes." });
  });

  it("cancels rather than answering, and never hangs", async () => {
    fixture.dialogs = [{ id: "d4", method: "input", title: "Name it" } satisfies UiDialogRequest];
    await mount(<ThreadDialogCards />);
    await press("Cancel");
    expect(fixture.actions.answerDialog).toHaveBeenCalledWith({ id: "d4", cancelled: true });
  });

  it("cancels a kind it cannot draw instead of leaving the session waiting", async () => {
    fixture.dialogs = [{ id: "d5", method: "custom", title: "Pick a colour" } as unknown as UiDialogRequest];
    await mount(<ThreadDialogCards />);
    expect(container.querySelector('[data-slot="dialog-card"]')).toBeNull();
    expect(fixture.actions.answerDialog).toHaveBeenCalledWith({ id: "d5", cancelled: true });
    expect(isRenderableDialog({ method: "custom" } as never)).toBe(false);
  });

  it("puts a question in its tool row when that row is on screen, and in the card when it is not", async () => {
    const dialog = { id: "d6", method: "confirm", title: "Delete the branch?", toolCallId: "call-1" } satisfies UiDialogRequest;
    fixture.dialogs = [dialog];

    // No row mounted: the card is the only home, so the question is still asked.
    await mount(<ThreadDialogCards />);
    expect(container.querySelector('[data-slot="dialog-card"]')?.textContent).toContain("Delete the branch?");

    await mount(
      <>
        <MountedRow toolCallId="call-1" />
        <ThreadDialogCards />
      </>,
    );
    expect(container.querySelector('[data-slot="tool-dialog"]')?.textContent).toContain("Delete the branch?");
    expect(container.querySelector('[data-slot="dialog-card"]')).toBeNull();
    // The same renderer either way, so the answer travels the same road.
    await press("Yes");
    expect(fixture.actions.answerDialog).toHaveBeenCalledWith({ id: "d6", confirmed: true });
  });

  it("shows one question at a time and says how many are behind it", async () => {
    fixture.dialogs = [
      { id: "a", method: "input", title: "First" } satisfies UiDialogRequest,
      { id: "b", method: "input", title: "Second" } satisfies UiDialogRequest,
    ];
    await mount(<ThreadDialogCards />);
    const card = container.querySelector('[data-slot="dialog-card"]')!;
    expect(card.textContent).toContain("First");
    expect(card.textContent).not.toContain("Second");
    expect(card.textContent).toContain("+1 more waiting behind this one");
  });
});

describe("the dialog form", () => {
  it("blocks the tool only when its row is really there", () => {
    const dialog = { id: "d", method: "confirm", title: "?", toolCallId: "call-1" } satisfies UiDialogRequest;
    expect(dialogFormOf(dialog, true)).toMatchObject({ blocking: "tool", toolCallId: "call-1" });
    expect(dialogFormOf(dialog, false).blocking).toBe("turn");
    expect(dialogFormOf(dialog, false).toolCallId).toBeUndefined();
  });

  it("gives 'No' somewhere to go, and maps every answer back by field id", () => {
    const form = dialogFormOf({ id: "d", method: "confirm", title: "?" }, false);
    expect(form.rejection).toEqual({ label: "No", field: "feedback" });
    expect(form.fields.some((field) => field.id === "feedback")).toBe(true);
    expect(uiResponseFor("d", "confirm", { confirmed: false })).toEqual({ id: "d", confirmed: false });
    // A value of the wrong shape is a cancel, never a guess.
    expect(uiResponseFor("d", "select", {})).toEqual({ id: "d", cancelled: true });
    expect(uiResponseFor("d", "editor", undefined)).toEqual({ id: "d", cancelled: true });
  });
});
