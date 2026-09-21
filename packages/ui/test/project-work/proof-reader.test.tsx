// @vitest-environment happy-dom
/**
 * M21-T19 · reading the proof a decision rests on, to the last byte of it.
 *
 * The trail beside this is proven in `verification.test.tsx`. What is proven
 * here is the reading itself, over the real `ProofTrail` and the real store,
 * against a blob server that pages exactly as the host does:
 *
 *   - everything a capture recorded is **reachable**, a page at a time — the
 *     twenty-first retained file can be opened and read, the twenty-first
 *     file named without its source can be read, and the sixth decision can
 *     be asked about; the page before is gone from the document, not stacked;
 *   - a character whose bytes straddle a 512 KB page boundary is read as the
 *     character it is, not as replacement characters;
 *   - bytes that are not the text they are stored as are **refused**, never
 *     shown as `\uFFFD`; a mark the file really carries is kept;
 *   - a part of a body never ends in half a character.
 *
 * (AGENTS.md, D-342: unit tests over the real components, never a browser.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_WORK_BLOB_PAGE_MAX_BYTES,
  REPOSITORY_CAPTURE_MEDIA_TYPE,
  type DecisionCaptureBinding,
  type ProjectWorkApproval,
  type ProjectWorkBody,
  type RepositoryCapture,
  type RepositoryCaptureHistoryPage,
  type RepositoryLink,
} from "@lasercode/protocol";

import { ProofTrail } from "../../src/components/project-work/ProofTrail.js";
import { PROOF_SOURCE_WINDOW_CHARS } from "../../src/components/project-work/verification-model.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { detail, taskBody, type Detail } from "./plan-task-fixture.js";

const LINK: RepositoryLink = {
  projectId: "p1",
  linkId: "rl_1",
  subject: { entityId: "e-task-44", revisionId: "e-task-44r1", kind: "task", key: "TASK-44", digest: "a".repeat(64) },
  relation: "implemented_by",
  repositoryId: "repo_1",
  target: {
    change: {
      base: { vcs: "git", objectFormat: "sha1", commitObjectId: "1".repeat(40) },
      head: { vcs: "git", objectFormat: "sha1", commitObjectId: "2".repeat(40) },
      diffDigest: "d".repeat(64),
    },
  },
  createdBy: { kind: "person", label: "You" },
  createdAt: "2026-03-01T09:00:00.000Z",
  captureBlobId: "blb_corrected",
};

const BOUND = "blb_atthetime";

const binding = (over: Partial<DecisionCaptureBinding> = {}): DecisionCaptureBinding => ({
  kind: "task_completion",
  decisionId: "42",
  entityId: "e-task-44",
  linkId: "rl_1",
  blobId: BOUND,
  associationRevisionId: "rlc_1",
  associationSeq: 2,
  boundAt: "2026-03-01T09:06:00.000Z",
  ...over,
});

const approval = (over: Partial<ProjectWorkApproval> & { approvalId: string; at: string }): ProjectWorkApproval => ({
  projectId: "p1",
  entityId: "e-task-44",
  gate: "build",
  decision: "approved",
  covers: [],
  origin: { actor: { kind: "person", label: "You" } },
  ...over,
});

const source = (path: string, text: string, side?: "before" | "after") => ({
  path,
  bytes: Buffer.byteLength(text, "utf8"),
  contentDigest: "e".repeat(64),
  text,
  ...(side ? { side } : {}),
});

const capture = (over: Partial<RepositoryCapture> = {}): RepositoryCapture =>
  ({
    version: 1,
    createdAt: "2026-03-01T09:05:00.000Z",
    repositoryId: "repo_1",
    repositoryName: "app",
    change: {
      base: { vcs: "git", objectFormat: "sha1", commitObjectId: "1".repeat(40) },
      head: { vcs: "git", objectFormat: "sha1", commitObjectId: "2".repeat(40) },
      diffDigest: "d".repeat(64),
    },
    files: [{ path: "src/a.ts", status: "modified", added: 2, removed: 1 }],
    sources: [source("src/a.ts", "delivered\n")],
    ...over,
  }) as RepositoryCapture;

const historyPage = (over: Partial<RepositoryCaptureHistoryPage>, extra: Partial<Detail> = {}): Record<string, unknown> => ({
  ...subject(extra),
  captureHistory: { of: "decisions", associations: [], bindings: [], ...over },
});

function subject(extra: Partial<Detail> = {}): Detail {
  return {
    ...detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
      repositoryLinks: [LINK],
    }),
    ...extra,
  };
}

let root: Root;
let container: HTMLDivElement;
let storeCalls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }>;
/** Whole blobs, by id, exactly as bytes. The store pages them like the host. */
let blobBytes: Map<string, Uint8Array>;
/** Blobs whose page answer is written by hand, for bytes no encoder produces. */
let blobAnswers: Map<string, Record<string, unknown>>;
let getAnswers: Array<Record<string, unknown>>;

const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A store over a blob server that pages the way the host does: at most
 * {@link PROJECT_WORK_BLOB_PAGE_MAX_BYTES} bytes an answer, cut wherever that
 * byte falls, with `nextOffset` until the last one.
 */
const makeStore = (): ProjectWorkStore => {
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: unknown) => {
      storeCalls.push({ method, params: params as Record<string, unknown> });
      if (method === "project/work/blob/read") {
        const asked = params as { blobId: string; offset?: number; limit?: number };
        const written = blobAnswers.get(asked.blobId);
        if (written) return written;
        const bytes = blobBytes.get(asked.blobId);
        if (!bytes) throw new Error("That attachment is not in this project — it may have been deleted.");
        const offset = asked.offset ?? 0;
        const end = Math.min(bytes.length, offset + (asked.limit ?? PROJECT_WORK_BLOB_PAGE_MAX_BYTES));
        const slice = bytes.subarray(offset, end);
        return {
          blobId: asked.blobId,
          mediaType: REPOSITORY_CAPTURE_MEDIA_TYPE,
          digest: "f".repeat(64),
          totalBytes: bytes.length,
          offset,
          bytes: slice.length,
          ...(end < bytes.length ? { nextOffset: end } : {}),
          data: Buffer.from(slice).toString("base64"),
        };
      }
      if (method === "project/work/get") {
        const answer = getAnswers.shift();
        if (!answer) throw new Error("no detail answer was prepared");
        return answer;
      }
      if (method === "project/work/list") {
        return {
          projectId: "p1",
          seq: 1,
          items: [],
          counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } },
        };
      }
      return {};
    }) as never,
  });
  store.rememberPath("/work/app");
  return store;
};

/** The bound capture, as the bytes a blob read walks. */
const store_capture = (value: RepositoryCapture | Record<string, unknown>, id = BOUND): void => {
  blobBytes.set(id, new Uint8Array(Buffer.from(JSON.stringify(value), "utf8")));
};

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => (node.textContent ?? "").includes(label));
const labelled = (name: string): HTMLButtonElement | null => document.body.querySelector(`button[aria-label="${name}"]`);
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element, "the control this step needs is on screen").toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await settle(10);
  });
};

const mount = async (value: Detail, store: ProjectWorkStore): Promise<void> => {
  await act(async () => {
    root.render(<ProofTrail store={store} detail={value} />);
    await settle(10);
  });
};

/** Open the proof one decision was bound to, which is what every test reads. */
const openBoundProof = async (store: ProjectWorkStore, extra: Partial<Detail> = {}): Promise<void> => {
  getAnswers = [historyPage({ of: "decisions", bindings: [binding()] }, extra)];
  await click(button("What decisions here rest on"));
  await click(button("Open this proof"));
};

const bodyText = (): string => document.body.querySelector('[data-slot="proof-trail-source-text"]')?.textContent ?? "";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  storeCalls = [];
  blobBytes = new Map();
  blobAnswers = new Map();
  getAnswers = [];
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("everything a proof holds stays reachable", () => {
  const many = (count: number): RepositoryCapture =>
    capture({
      files: Array.from({ length: count }, (_, at) => ({
        path: `src/file-${String(at).padStart(2, "0")}.ts`,
        status: "modified" as const,
        added: 1,
        removed: 0,
      })),
      sources: Array.from({ length: count }, (_, at) =>
        source(`src/file-${String(at).padStart(2, "0")}.ts`, `the body of file ${String(at).padStart(2, "0")}\n`),
      ),
    });

  it("reads the twenty-first retained file, which no first page ever showed", async () => {
    store_capture(many(24));
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);

    const first = [...document.body.querySelectorAll('[data-slot="proof-trail-sources"] li')];
    expect(first.length, "one bounded page of files").toBe(20);
    expect(text()).toContain("Files 1–20 of 24.");
    expect(text(), "the twenty-first is not on the first page").not.toContain("src/file-20.ts");

    await click(labelled("Next files this proof kept"));
    expect(text(), "and the page before it is gone rather than stacked under it").not.toContain("src/file-00.ts");
    expect(text()).toContain("Files 21–24 of 24.");
    const second = [...document.body.querySelectorAll('[data-slot="proof-trail-sources"] li')];
    expect(second.length).toBe(4);
    expect(second[0]?.textContent).toContain("src/file-20.ts");

    await click(second[0]?.querySelector("button"));
    expect(bodyText(), "the retained text of the twenty-first file, read out of the bound proof").toBe("the body of file 20\n");
    const read = storeCalls.filter((call) => call.method === "project/work/blob/read").at(-1);
    expect(read?.params["blobId"]).toBe(BOUND);

    await click(labelled("Previous files this proof kept"));
    const listed = document.body.querySelector('[data-slot="proof-trail-sources"]')?.textContent ?? "";
    expect(listed).toContain("src/file-00.ts");
    expect(listed, "the page turned back, and only that page is listed").not.toContain("src/file-20.ts");
    expect(bodyText(), "the file being read is still being read, because the index moved and it did not").toBe(
      "the body of file 20\n",
    );
  });

  it("names the twenty-first file it did not keep, with the reason it did not", async () => {
    store_capture(
      capture({
        files: [
          { path: "src/a.ts", status: "modified", added: 1, removed: 0 },
          ...Array.from({ length: 22 }, (_, at) => ({
            path: `assets/omitted-${String(at).padStart(2, "0")}.png`,
            status: "added" as const,
            added: null,
            removed: null,
            omitted: (at === 20 ? "too_large" : "binary") as "too_large" | "binary",
          })),
        ],
      }),
    );
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);

    expect([...document.body.querySelectorAll('[data-slot="proof-trail-omitted"] li')].length).toBe(20);
    expect(text()).not.toContain("assets/omitted-20.png");
    expect(text(), "the twenty-first reason is not on the first page either").not.toContain("too large to keep whole");

    await click(labelled("Next files named without their source"));
    expect(text()).toContain("assets/omitted-20.png");
    expect(text()).toContain("too large to keep whole, so none of it was kept");
    expect(text(), "and the page before it went with it").not.toContain("assets/omitted-00.png");
  });

  it("asks about the sixth decision, which the first five never offered", async () => {
    const approvals = Array.from({ length: 6 }, (_, at) =>
      approval({ approvalId: `apv_${String(at + 1)}`, at: `2026-03-0${String(at + 1)}T09:00:00.000Z` }),
    );
    const store = makeStore();
    await mount(subject({ approvals }), store);
    getAnswers = [historyPage({ of: "decisions", bindings: [binding()] }, { approvals })];
    await click(button("What decisions here rest on"));

    const offered = () => [...(document.body.querySelector('[data-slot="proof-trail-decisions"]')?.querySelectorAll("button") ?? [])];
    expect(offered().filter((node) => (node.textContent ?? "").includes("build ·")).length, "five at a time, newest first").toBe(5);
    expect(text()).toContain("Decisions 1–5 of 6.");

    await click(labelled("Older decisions"));
    const older = offered().filter((node) => (node.textContent ?? "").includes("build ·"));
    expect(older.length, "and the sixth is on the next page, not lost").toBe(1);
    expect(text()).toContain("Decisions 6–6 of 6.");

    getAnswers = [historyPage({ of: "decisions", bindings: [], known: false }, { approvals })];
    await click(older[0]);
    const asked = storeCalls.filter((call) => call.method === "project/work/get").at(-1);
    expect(
      (asked?.params["include"] as { captureHistory?: { decisionId?: string } }).captureHistory?.decisionId,
      "the oldest decision, asked about by its own id",
    ).toBe("apv_1");
    expect(text()).toContain("no record of what this decision rested on");
    expect(text(), "and no cause is invented for the absence").not.toContain("it was decided before that record was kept");
  });
});

describe("the bytes are read as the text they are", () => {
  const PAGE = PROJECT_WORK_BLOB_PAGE_MAX_BYTES;
  const EDGE = "src/edge.ts";
  const MULTIBYTE = "字";

  /**
   * A capture whose bytes are long enough to be paged, with one three-byte
   * character starting exactly one byte before the first page boundary — so
   * its first byte is on page one and its other two are on page two.
   */
  function straddling(): { bytes: Uint8Array; body: string } {
    const body = `before ${MULTIBYTE} after`;
    const marker = Buffer.from(MULTIBYTE, "utf8");
    let padding = PAGE - 200;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const value = capture({
        files: [
          { path: "src/filler.ts", status: "modified", added: 1, removed: 0 },
          { path: EDGE, status: "modified", added: 1, removed: 0 },
        ],
        sources: [source("src/filler.ts", "f".repeat(padding)), source(EDGE, body)],
      });
      const bytes = Buffer.from(JSON.stringify(value), "utf8");
      const at = bytes.indexOf(marker);
      expect(at, "the multibyte character is in the encoded capture").toBeGreaterThan(0);
      if (at === PAGE - 1) return { bytes: new Uint8Array(bytes), body };
      padding += PAGE - 1 - at;
      expect(padding, "the filler stays a sane size").toBeGreaterThan(0);
    }
    throw new Error("could not place the character on the page boundary");
  }

  it("reads a character whose bytes straddle a page boundary as that character", async () => {
    const { bytes, body } = straddling();
    expect(bytes.length, "this capture really is paged").toBeGreaterThan(PAGE);
    blobBytes.set(BOUND, bytes);
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);
    expect(storeCalls.filter((call) => call.method === "project/work/blob/read").length, "more than one page was read").toBeGreaterThan(1);

    const entries = [...document.body.querySelectorAll('[data-slot="proof-trail-sources"] li')];
    const edge = entries.find((node) => (node.textContent ?? "").includes(EDGE));
    await click(edge?.querySelector("button"));
    expect(bodyText(), "the exact source, not a repaired version of it").toBe(body);
    expect(bodyText(), "and nothing was replaced").not.toContain("\uFFFD");
  });

  it("refuses bytes that are not the text they are stored as, rather than showing damage as content", async () => {
    const { bytes } = straddling();
    // The last page is cut inside a character: what a truncated or damaged
    // blob looks like from here.
    blobBytes.set(BOUND, bytes.slice(0, PAGE));
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);
    expect(text()).toContain("not the text they are stored as");
    expect(text(), "no replacement character is offered as if it were the source").not.toContain("\uFFFD");
    expect(text(), "and nothing of a capture is claimed").not.toContain("It keeps everything");
    expect(text(), "the record is kept; the proof is what cannot be read").toContain("The record of this decision is kept");
  });

  it("refuses a page that is not the encoding it claims to be", async () => {
    blobAnswers.set(BOUND, {
      blobId: BOUND,
      mediaType: REPOSITORY_CAPTURE_MEDIA_TYPE,
      digest: "f".repeat(64),
      totalBytes: 12,
      offset: 0,
      bytes: 12,
      data: "not base64!!",
    });
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);
    expect(text()).toContain("did not arrive in a form this window can read");
  });

  it("keeps a byte order mark the file itself carries", async () => {
    const marked = "\uFEFFconst a = 1;\n";
    store_capture(capture({ sources: [source("src/a.ts", marked)] }));
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);
    await click(button("Read it"));
    expect(bodyText(), "the mark is part of the file, so it is part of what is read").toBe(marked);
    expect(bodyText().charCodeAt(0)).toBe(0xfeff);
  });

  it("never ends a part in half a character", async () => {
    // One ASCII character, then characters that are two UTF-16 units each:
    // the two-thousandth unit falls between the halves of one of them.
    const body = `a${"😀".repeat(1500)}`;
    store_capture(capture({ sources: [source("src/a.ts", body)] }));
    const store = makeStore();
    await mount(subject(), store);
    await openBoundProof(store);
    await click(button("Read it"));

    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const parts: string[] = [bodyText()];
    expect(parts[0]?.length, "the part is still bounded").toBeLessThanOrEqual(PROOF_SOURCE_WINDOW_CHARS);
    expect(lonely.test(parts[0] ?? ""), "and no half a character is on screen").toBe(false);
    expect(parts[0]?.endsWith("😀"), "the character that would have been split went to the next part").toBe(true);

    while (button("Next part")) {
      await click(button("Next part"));
      const next = bodyText();
      expect(next.length).toBeLessThanOrEqual(PROOF_SOURCE_WINDOW_CHARS);
      expect(lonely.test(next), "every part is whole characters").toBe(false);
      parts.push(next);
    }
    expect(parts.join(""), "and the parts are exactly the retained text, joined back up").toBe(body);
  });
});
