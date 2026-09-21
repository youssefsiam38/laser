// @vitest-environment happy-dom
/**
 * Import…, Export… and Publish… (M21-T21).
 *
 * Four things a screenshot cannot prove, and the reason this file exists:
 *
 * 1. Every one of the three ends in a **preview**, and the confirming call
 *    carries that preview's own digest back to the host.
 * 2. A collision is a decision: the import cannot be confirmed while anything
 *    is still undecided, and the choice a person made is what is sent.
 * 3. A re-export is an explicit replace-or-keep-both choice, sent as the mode.
 * 4. **Enter confirms nothing**, and the cancelling control holds focus.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportDialog, ImportDialog, PublishDialog } from "../../src/components/project-work/ImportExportDialogs.js";
import { ProjectWorkStore, type ProjectWorkMethod, type ProjectWorkRequest } from "../../src/project-work/store.js";

import { PROJECT_DIR_NAME, WORK_EXPORT_DIR } from "@lasercode/protocol";

import { fakeHost, item, type FakeProject } from "./fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ actions: { toast: () => {} } }),
    useCapability: () => ({ state: "available" }),
  };
});

let root: Root;
let container: HTMLDivElement;

const DIGEST = "a".repeat(64);
/** The default export root, spelled the one way the product spells it. */
const ROOT = `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`;

const world = (): FakeProject => ({
  projectId: "p1",
  paths: ["/work/app"],
  seq: 3,
  items: [item({ entityId: "e1", kind: "spec", number: 4 })],
  events: [],
});

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => node.textContent?.includes(label));

interface Fixture {
  store: ProjectWorkStore;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  answers: Map<string, unknown>;
}

async function fixture(): Promise<Fixture> {
  const host = fakeHost([world()]);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const answers = new Map<string, unknown>();
  const request = (async (method: ProjectWorkMethod, params: unknown) => {
    if (method.startsWith("project/work/import/") || method.startsWith("project/work/export/") || method.startsWith("project/work/publish/")) {
      calls.push({ method, params: params as Record<string, unknown> });
      const answer = answers.get(method);
      if (answer === undefined) throw new Error(`nothing answers ${method}`);
      return answer;
    }
    return host.request(method as ProjectWorkMethod, params as never);
  }) as ProjectWorkRequest;
  const store = new ProjectWorkStore({ request, projectId: "p1" });
  await store.open();
  return { store, calls, answers };
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
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
});

describe("Import…", () => {
  const preview = {
    adapter: "spec_kit",
    root: "specs",
    previewDigest: DIGEST,
    proposals: [
      {
        sourceId: "spec_kit:specs/001-phone/spec.md",
        kind: "spec",
        title: "Phone review",
        summary: "A reviewer decides from anywhere.",
        source: { adapter: "spec_kit", path: "specs/001-phone/spec.md", digest: "b".repeat(64), licence: "permissive", licenceName: "MIT License" },
        action: "create",
        notes: [],
      },
      {
        sourceId: "spec_kit:specs/001-phone/tasks.md#T001",
        kind: "task",
        title: "Sticky footer",
        summary: "not started in the source list",
        source: { adapter: "spec_kit", path: "specs/001-phone/tasks.md", digest: "c".repeat(64) },
        match: { entityId: "e9", key: "TASK-2", title: "Sticky footer", digest: "d".repeat(64), matchedBy: "title" },
        conflict: { reason: "title", choices: ["new_revision", "new_entity", "skip"] },
        action: "decide",
        notes: [],
      },
    ],
    creates: 1,
    conflicts: 1,
    skipped: [{ path: "specs/001-phone/notes.txt", reason: "no front matter saying what it is" }],
    watches: false,
  };

  it("previews first, refuses to import while anything is undecided, and sends the decision and the digest", async () => {
    const world = await fixture();
    world.answers.set("project/work/import/preview", preview);
    world.answers.set("project/work/import/apply", {
      adapter: "spec_kit",
      root: "specs",
      applied: [],
      created: 1,
      revised: 1,
      skipped: 0,
      relations: 0,
      seq: 9,
      watches: false,
    });

    await act(async () => root.render(<ImportDialog store={world.store} open onOpenChange={() => {}} />));
    await act(async () => {});

    // Opening reads nothing: the preview is a deliberate press.
    expect(world.calls).toEqual([]);
    expect(text()).toContain("Nothing has been read yet");
    // The cancelling control holds focus, never the one that acts.
    expect(document.activeElement?.textContent).toContain("Cancel");

    await act(async () => button("Look at the files")?.click());
    expect(world.calls.map((call) => call.method)).toEqual(["project/work/import/preview"]);
    expect(text()).toContain("Phone review");
    expect(text()).toContain("specs/001-phone/spec.md");
    expect(text()).toContain("MIT License");
    expect(text()).toContain("would be created");

    // One collision, so importing is not possible yet.
    expect(button("1 still to decide")?.disabled).toBe(true);

    await act(async () => button("New revision")?.click());
    const confirm = button("Import");
    expect(confirm?.disabled).toBe(false);

    await act(async () => confirm?.click());
    const apply = world.calls.find((call) => call.method === "project/work/import/apply")!;
    expect(apply.params["confirm"]).toBe(true);
    expect(apply.params["previewDigest"]).toBe(DIGEST);
    expect(apply.params["decisions"]).toEqual([{ sourceId: "spec_kit:specs/001-phone/tasks.md#T001", choice: "new_revision" }]);
  });

  it("never lets Enter in the folder field read or import anything", async () => {
    const world = await fixture();
    world.answers.set("project/work/import/preview", preview);
    await act(async () => root.render(<ImportDialog store={world.store} open onOpenChange={() => {}} />));
    await act(async () => {});

    const field = document.body.querySelector<HTMLInputElement>('input[aria-label="Folder in this project to import from"]')!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      field.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(world.calls).toEqual([]);
  });
});

describe("Export…", () => {
  const base = {
    root: ROOT,
    previewDigest: DIGEST,
    files: [
      { path: "SPEC-4.md", role: "document", bytes: 412, digest: "b".repeat(64), key: "SPEC-4" },
      { path: "manifest.json", role: "manifest", bytes: 640, digest: "c".repeat(64) },
    ],
    entities: 1,
    attachments: 0,
    totalBytes: 1052,
    mode: "replace",
    removes: [],
  };

  it("previews the exact files on open and sends that digest when it is confirmed", async () => {
    const world = await fixture();
    world.answers.set("project/work/export/preview", base);
    world.answers.set("project/work/export/apply", { ...base, files: base.files, removed: [], manifestDigest: "c".repeat(64), seq: 9 });

    await act(async () => root.render(<ExportDialog store={world.store} open onOpenChange={() => {}} />));
    await act(async () => {});

    expect(world.calls.map((call) => call.method)).toEqual(["project/work/export/preview"]);
    expect(text()).toContain("SPEC-4.md");
    expect(text()).toContain("manifest.json");
    expect(text()).toContain(ROOT);
    expect(document.activeElement?.textContent).toContain("Cancel");

    await act(async () => button("Export")?.click());
    const apply = world.calls.find((call) => call.method === "project/work/export/apply")!;
    expect(apply.params["confirm"]).toBe(true);
    expect(apply.params["previewDigest"]).toBe(DIGEST);
    expect(apply.params["mode"]).toBeUndefined();
  });

  it("makes a re-export an explicit replace-or-keep-both choice", async () => {
    const world = await fixture();
    world.answers.set("project/work/export/preview", {
      ...base,
      existing: { root: ROOT, files: 4, manifestDigest: "c".repeat(64), unchanged: true },
      decide: { reason: "existing_export", choices: ["replace", "new_revision"] },
    });
    world.answers.set("project/work/export/apply", { ...base, removed: [], manifestDigest: "c".repeat(64), seq: 9 });

    await act(async () => root.render(<ExportDialog store={world.store} open onOpenChange={() => {}} />));
    await act(async () => {});

    expect(text()).toContain("There is already an export at");
    expect(button("Choose one first")?.disabled).toBe(true);

    await act(async () => button("Replace it")?.click());
    // Choosing re-previews with the mode, so the digest fences that choice.
    const previews = world.calls.filter((call) => call.method === "project/work/export/preview");
    expect(previews).toHaveLength(2);
    expect(previews[1]?.params["mode"]).toBe("replace");

    await act(async () => button("Export")?.click());
    const apply = world.calls.find((call) => call.method === "project/work/export/apply")!;
    expect(apply.params["mode"]).toBe("replace");
    expect(apply.params["previewDigest"]).toBe(DIGEST);
  });
});

describe("Publish…", () => {
  const entity = {
    entityId: "e1",
    key: "SPEC-4",
    revisionId: "r1",
    digest: "b".repeat(64),
    publishedPath: `${ROOT}/SPEC-4.md`,
  };

  it("will not record anything while the export is not committed, and says what to do", async () => {
    const world = await fixture();
    world.answers.set("project/work/publish/preview", {
      root: ROOT,
      previewDigest: DIGEST,
      repository: { repositoryId: "repo_1", name: "app", objectFormat: "sha1", head: "0".repeat(40), branch: "main" },
      files: [{ path: `${ROOT}/SPEC-4.md`, digest: "b".repeat(64), committed: false }],
      uncommitted: [`${ROOT}/SPEC-4.md`],
      entities: [entity],
      commit: { method: "pi/project/git/commit", cwd: "/work/app", paths: [ROOT], message: "Publish project work export (1 item)" },
      ready: false,
      refusal: "1 exported file is not committed yet.",
    });

    await act(async () => root.render(<PublishDialog store={world.store} open onOpenChange={() => {}} />));
    await act(async () => {});

    expect(text()).toContain("not committed yet");
    expect(text()).toContain("Source control");
    expect(button("Record it")?.disabled).toBe(true);
    expect(world.calls.some((call) => call.method === "project/work/publish/apply")).toBe(false);
  });

  it("records the publication against the commit once every exported file is in it", async () => {
    const world = await fixture();
    world.answers.set("project/work/publish/preview", {
      root: ROOT,
      previewDigest: DIGEST,
      repository: { repositoryId: "repo_1", name: "app", objectFormat: "sha1", head: "1".repeat(40), branch: "main" },
      files: [{ path: `${ROOT}/SPEC-4.md`, digest: "b".repeat(64), committed: true }],
      uncommitted: [],
      entities: [entity],
      ready: true,
    });
    world.answers.set("project/work/publish/apply", {
      root: ROOT,
      repositoryId: "repo_1",
      commitObjectId: "1".repeat(40),
      objectFormat: "sha1",
      state: { vcs: "git", objectFormat: "sha1", commitObjectId: "1".repeat(40) },
      published: [{ entityId: "e1", key: "SPEC-4", linkId: "lnk_1", publishedPath: `${ROOT}/SPEC-4.md` }],
      seq: 9,
    });

    await act(async () => root.render(<PublishDialog store={world.store} open onOpenChange={() => {}} />));
    await act(async () => {});

    expect(text()).toContain("SPEC-4");
    expect(text()).toContain(`${ROOT}/SPEC-4.md`);
    expect(button("Record it")?.disabled).toBe(false);

    await act(async () => button("Record it")?.click());
    const apply = world.calls.find((call) => call.method === "project/work/publish/apply")!;
    expect(apply.params["confirm"]).toBe(true);
    expect(apply.params["previewDigest"]).toBe(DIGEST);
    expect(apply.params["commit"]).toBe("HEAD");
  });
});
