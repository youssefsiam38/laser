// @vitest-environment happy-dom
/**
 * What this folder is, in the workspace (M21-T20).
 *
 * A project's work is partitioned by a stable id, so a folder that was copied
 * from another project's folder is a question: the two histories are kept
 * apart until a person answers it. The surface for that is one strip above the
 * backlog, and what is proven here is that it says the host's own sentence,
 * offers exactly the choices the host offered, and — the part that matters —
 * sends the digest of the preview the person read back with their answer.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectIdentityResult } from "@lasercode/protocol";

import { IdentityNotice } from "../../src/components/project-work/IdentityNotice.js";
import { ProjectWorkStore, type ProjectWorkMethod, type ProjectWorkSnapshot } from "../../src/project-work/store.js";

import { countsOf, fakeHost, item, type FakeProject } from "./fixture.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const HERE = "/work/app-copy";
const THERE = "/work/app";

const conflict: ProjectIdentityResult = {
  cwd: HERE,
  projectId: "p2",
  state: "conflict",
  here: { projectId: "p2", path: HERE, name: "app-copy", pathExists: true, entities: 0 },
  marked: { projectId: "p1", path: THERE, name: "app", pathExists: true, entities: 12 },
  marker: true,
  hidden: false,
  detail: "This folder was copied from app, and that folder is still here too.",
  choices: ["reconnect", "fresh"],
  previewDigest: "c".repeat(64),
};

const snapshot = (identity: ProjectIdentityResult | undefined): ProjectWorkSnapshot => ({
  projectId: identity?.projectId,
  phase: "ready",
  error: undefined,
  seq: 1,
  eventSeq: 1,
  items: [],
  counts: countsOf([]),
  attention: { needsYou: 0, seq: 1 },
  recent: [],
  behind: false,
  loading: false,
  resets: 0,
  more: false,
  identity,
});

function renderNotice(work: ProjectWorkSnapshot, store?: ProjectWorkStore): void {
  act(() => {
    root.render(<IdentityNotice store={store} work={work} />);
  });
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll("button")];
const click = (label: string): void => {
  const button = buttons().find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`no button reading ${label}: ${buttons().map((b) => b.textContent ?? "").join(" | ")}`);
  act(() => button.click());
};

describe("the identity notice", () => {
  it("says nothing at all when the folder and its project agree", () => {
    renderNotice(snapshot({ ...conflict, state: "linked", choices: [], marked: undefined, detail: "This folder is part of this project." }));
    expect(container.querySelector("[data-slot='project-identity-notice']")).toBeNull();
    renderNotice(snapshot(undefined));
    expect(container.textContent).toBe("");
  });

  it("offers both sides of a copied folder, in the host's own words", () => {
    renderNotice(snapshot(conflict));
    const notice = container.querySelector("[data-slot='project-identity-notice']")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("copied from app");
    // Named, so the choice is not "yes/no" to a question about two folders.
    expect(buttons().map((button) => button.textContent)).toEqual(["Continue app here", "Keep this folder separate"]);
  });

  it("offers only the separate side when this folder already holds work", () => {
    renderNotice(
      snapshot({
        ...conflict,
        state: "blocked",
        here: { ...conflict.here, entities: 3 },
        choices: ["fresh"],
        detail: "Reconnecting would merge two histories, so it is not offered.",
      }),
    );
    expect(buttons().map((button) => button.textContent)).toEqual(["Keep this folder separate"]);
    expect(container.textContent).toContain("merge two histories");
  });

  it("says a removed project's work is kept, and asks nothing", () => {
    renderNotice(
      snapshot({
        ...conflict,
        state: "linked",
        marked: undefined,
        choices: [],
        hidden: true,
        detail: "This project was removed from your list. Its work is kept and hidden until you delete it.",
      }),
    );
    const notice = container.querySelector("[data-slot='project-identity-notice']")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("kept and hidden");
    expect(buttons()).toHaveLength(0);
  });
});

describe("answering the question", () => {
  function world(): { host: ReturnType<typeof fakeHost>; store: ProjectWorkStore; projects: FakeProject[] } {
    const projects: FakeProject[] = [
      { projectId: "p1", paths: [THERE], seq: 10, items: [item({ entityId: "e1", kind: "spec", number: 1 })], events: [] },
      { projectId: "p2", paths: [HERE], seq: 1, items: [], events: [] },
    ];
    const host = fakeHost(projects);
    const answered: Record<string, unknown> = { ...conflict };
    const inner = host.request;
    host.request = (async (method: ProjectWorkMethod, params: unknown) => {
      if (method === "project/work/identity") {
        host.calls.push({ method, params });
        return answered;
      }
      if (method === "project/work/relink") {
        host.calls.push({ method, params });
        const request = params as { choice: string; projectId: string; previewDigest: string };
        if (request.previewDigest !== conflict.previewDigest) throw new Error("This folder changed since you were shown those two projects.");
        if (request.choice === "reconnect") {
          projects[0]!.paths = [HERE];
          projects.splice(1, 1);
          Object.assign(answered, { projectId: "p1", state: "linked", choices: [], marked: undefined, detail: "This folder is part of this project." });
          return { cwd: HERE, projectId: "p1", choice: "reconnect", previousProjectId: "p2", discardedEmpty: true, marker: true, detail: "done" };
        }
        Object.assign(answered, { state: "linked", choices: [], marked: undefined, detail: "This folder keeps its own project work." });
        return { cwd: HERE, projectId: "p2", choice: "fresh", marker: true, detail: "done" };
      }
      return inner(method as never, params as never);
    }) as typeof host.request;
    return { host, store: new ProjectWorkStore({ request: host.request }), projects };
  }

  it("reads what the folder is and reconnects it to the project it came from", async () => {
    const { host, store } = world();
    store.rememberPath(HERE);
    await store.checkIdentity();
    expect(store.getSnapshot().identity?.state).toBe("conflict");

    renderNotice(store.getSnapshot(), store);
    click("Continue app here");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const relink = host.calls.find((call) => call.method === "project/work/relink")!;
    // The digest of the preview the person read, so the host can refuse a
    // folder that changed underneath rather than relink it unseen.
    expect(relink.params).toMatchObject({ cwd: HERE, choice: "reconnect", projectId: "p1", previewDigest: conflict.previewDigest, confirm: true });
    const after = store.getSnapshot();
    expect(after.projectId).toBe("p1");
    expect(after.items.map((row) => row.key)).toEqual(["SPEC-1"]);
    expect(after.identity?.choices).toEqual([]);
  });

  it("keeps the two apart when that is the answer, and reads no other project's work", async () => {
    const { host, store } = world();
    store.rememberPath(HERE);
    await store.checkIdentity();
    const outcome = await store.relink("fresh");
    expect(outcome.ok).toBe(true);
    expect(host.calls.find((call) => call.method === "project/work/relink")?.params).toMatchObject({ choice: "fresh", projectId: "p2" });
    const after = store.getSnapshot();
    expect(after.projectId).toBe("p2");
    expect(after.items).toEqual([]);
    expect(after.identity?.state).toBe("linked");
  });

  it("shows the host's refusal and leaves the question standing", async () => {
    const { store } = world();
    store.rememberPath(HERE);
    await store.checkIdentity();
    // A preview from before the folder changed: the host refuses it.
    (store.getSnapshot().identity as { previewDigest: string }).previewDigest = "d".repeat(64);
    const outcome = await store.relink("reconnect");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failure.message).toContain("changed since you were shown");
    expect(store.getSnapshot().projectId).not.toBe("p1");
  });
});
