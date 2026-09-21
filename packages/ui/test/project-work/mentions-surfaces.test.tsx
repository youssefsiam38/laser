// @vitest-environment happy-dom
/**
 * M21-T9: where a mention shows up outside the workspace.
 *
 * The transcript chip and the compact card, the composer's record of a chosen
 * mention, and the sessions sidebar's link from a conversation to the Task it
 * is an attempt at. What is proven here is what a person can see and press:
 * the chip says the key, it opens the exact revision the message pinned, and
 * the identity lines the message carries are never drawn.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectWorkMentionDefinition, type ClientRequests, type ProjectWorkRef } from "@lasercode/protocol";

import { DirectiveString } from "../../src/components/assistant-ui/elements/directive-text.aui.js";
import { createFinishedMentions } from "../../src/components/thread/finished-mentions.js";
import { ProjectWorkStore, type ProjectWorkMethod, type ProjectWorkRequest } from "../../src/project-work/store.js";
import { clearSessionTaskLinks, useSessionTaskLink } from "../../src/project-work/mentions.js";
import { resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";

import { countsOf, item } from "./fixture.js";

const ref: ProjectWorkRef = {
  projectId: "p1",
  kind: "task",
  entityId: "e44",
  revisionId: "r3",
  digest: "a".repeat(64),
  key: "TASK-44",
  label: "Rework the picker",
};

const sent = (prose: string, refs: Array<[string, ProjectWorkRef]> = [["TASK-44", ref]]): string =>
  [prose, "", ...refs.map(([label, pinned]) => projectWorkMentionDefinition(label, pinned))].join("\n");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetWorkspaceUi();
  clearSessionTaskLinks();
});

describe("a mention in the transcript", () => {
  it("draws the key as a chip, keeps the prose, and never draws the identity lines", () => {
    act(() => root.render(<DirectiveString text={sent('Finish @TASK-44 "Rework the picker" today.')} />));

    const chip = container.querySelector<HTMLButtonElement>('[data-slot="work-mention"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("TASK-44");
    expect(chip!.textContent).toContain("Rework the picker");
    expect(chip!.dataset["kind"]).toBe("task");
    expect(container.textContent).toContain("Finish");
    expect(container.textContent).toContain("today.");
    // The identity is in the message, never on the screen.
    expect(container.textContent).not.toContain("sha256-");
    expect(container.textContent).not.toContain("work/p1");
  });

  it("opens the workspace on the exact revision the message pinned", () => {
    act(() => root.render(<DirectiveString text={sent("Look at @TASK-44 again")} />));
    const chip = container.querySelector<HTMLButtonElement>('[data-slot="work-mention"]')!;
    act(() => chip.click());

    const ui = workspaceUi();
    expect(ui.open).toBe(true);
    expect(ui.projectId).toBe("p1");
    expect(ui.selection).toMatchObject({ entityId: "e44", kind: "task", revisionId: "r3" });
  });

  it("reads as a compact card when the message is the reference", () => {
    act(() => root.render(<DirectiveString text={sent('@TASK-44 "Rework the picker"')} />));

    const card = container.querySelector<HTMLElement>('[data-slot="work-artifact-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("TASK-44");
    expect(card!.textContent).toContain("Rework the picker");
    // A project this window has not read yet still names what it has: the
    // body is never invented, and the card never shows one.
    expect(card!.textContent).toContain("Open it to read this revision");
  });

  it("leaves a key nobody pinned as the words somebody typed", () => {
    act(() => root.render(<DirectiveString text="look at TASK-44 and @SPEC-7 when you can" />));
    expect(container.querySelector('[data-slot="work-mention"]')).toBeNull();
    expect(container.textContent).toContain("@SPEC-7");
  });
});

describe("a chosen mention in the composer", () => {
  it("is finished the moment it is chosen, so the picker does not reopen on it", () => {
    const mentions = createFinishedMentions();
    mentions.advance("Finish ");
    mentions.noteChoice({ token: '@TASK-44 "Rework the picker"', type: "work", label: "TASK-44", workKind: "task" });
    const draft = 'Finish @TASK-44 "Rework the picker" ';
    const tags = mentions.advance(draft);

    expect(tags.map((tag) => tag.token)).toEqual(['@TASK-44 "Rework the picker"']);
    expect(tags[0]!.workKind).toBe("task");
    // The matcher refuses the `@` it already answered.
    expect(mentions.matcher(draft, "@", draft.length)).toBeNull();
  });

  it("keeps a restored draft's mention finished, and a half-typed key a query", () => {
    const restored = createFinishedMentions();
    expect(restored.advance('Finish @TASK-44 "Rework the picker" today').map((tag) => tag.type)).toEqual(["work"]);

    const typing = createFinishedMentions();
    typing.advance("");
    expect(typing.advance("Finish @TASK-4")).toHaveLength(0);
  });
});

describe("a conversation that is an attempt at a Task", () => {
  it("finds its Task by the session's own id, through the project's execution links", async () => {
    const task = item({ entityId: "e44", kind: "task", number: 44, title: "Rework the picker", linkCounts: { edges: 0, repository: 0, execution: 1 } });
    const calls: ProjectWorkMethod[] = [];
    const request = (async (method: ProjectWorkMethod, params: unknown) => {
      calls.push(method);
      if (method === "project/work/list") {
        return { projectId: "p1", seq: 4, items: [task], counts: countsOf([task]) } satisfies ClientRequests["project/work/list"]["result"];
      }
      if (method === "project/work/get") {
        expect((params as { body?: { mode: string } }).body?.mode).toBe("none");
        return {
          ref: task.ref,
          entity: { ...task.ref, keyNumber: 44, title: task.title, state: task.state, currentRevisionId: task.ref.revisionId, currentDigest: task.ref.digest, revisionCount: 1, createdAt: task.createdAt, updatedAt: task.updatedAt },
          revision: { projectId: "p1", entityId: "e44", revisionId: task.ref.revisionId, kind: "task", index: 1, title: task.title, digest: task.ref.digest, bodyBytes: 0, createdAt: task.createdAt, origin: { actor: { kind: "person", label: "You" } }, state: task.state },
          fence: { entityId: "e44", revisionId: task.ref.revisionId, digest: task.ref.digest, seq: 4 },
          edges: [],
          repositoryLinks: [],
          executionLinks: [
            { projectId: "p1", linkId: "l1", entityId: "e44", kind: "session", targetId: "ses_7", attempt: 1, startedAt: "2026-01-01T00:00:00.000Z", createdBy: { kind: "person", label: "You" } },
          ],
          comments: [],
          approvals: [],
          evidence: [],
          decisions: [],
          truncated: [],
        } as unknown as ClientRequests["project/work/get"]["result"];
      }
      throw new Error(`unexpected ${method}`);
    }) as unknown as ProjectWorkRequest;

    const store = new ProjectWorkStore({ request, projectId: "p1" });
    await store.open();

    let seen: ReturnType<typeof useSessionTaskLink>;
    function Probe({ id }: { id: string }) {
      seen = useSessionTaskLink(id, store);
      return null;
    }
    await act(async () => {
      root.render(<Probe id="ses_7" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(seen).toMatchObject({ key: "TASK-44", attempt: 1 });
    expect(seen!.target).toEqual({ projectId: "p1", kind: "task", entityId: "e44", revisionId: task.ref.revisionId });
    // One read per Task with links, shared by every row that asks.
    expect(calls.filter((method) => method === "project/work/get")).toHaveLength(1);
  });
});
