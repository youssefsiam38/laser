// @vitest-environment happy-dom
/**
 * M21-T19 · a person's review of a real build, recorded (D-353, D-361).
 *
 * What these prove is exactly what a person is protected by, and none of it is
 * visible in a screenshot:
 *
 *   - the action is **visible and explained** when it cannot be used, never
 *     silently absent;
 *   - the recorded request carries the **exact tuple** the host wrote from git
 *     — this repository's own id, object format, checkpoint ref and commit —
 *     and never a derived or workspace-wide one;
 *   - the subject is the **criterion's** authority revision: a Design when the
 *     criterion came from one, the Task when it did not;
 *   - cancelling, an unconfirmed attestation, a checkpoint that is gone and a
 *     host refusal all write **nothing**;
 *   - changing what is being accepted takes the confirmation back;
 *   - only the newest liveness answer counts.
 *
 * (AGENTS.md, D-342: unit tests over the real components, never a browser.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  checkpointRef,
  type CheckpointList,
  type ProjectWorkBody,
  type VerificationCriterion,
  type VerificationReport,
} from "@lasercode/protocol";

import { NativeAcceptanceDialog } from "../../src/components/project-work/NativeAcceptance.js";
import { VerificationPanel } from "../../src/components/project-work/VerificationPanel.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { attemptRepository, detail, evidence, executionLink, taskBody, type Detail } from "./plan-task-fixture.js";

const SESSION = { id: "s1", path: "/work/app/one.jsonl" };
let sessions: Array<{ id: string; path: string }>;
let hostCalls: Array<{ method: string; params: Record<string, unknown> }>;
let hostAnswer: (method: string, params: Record<string, unknown>) => Promise<unknown>;

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({
      actions: { toast: () => {} },
      client: {
        request: async (method: string, params: unknown) => {
          hostCalls.push({ method, params: params as Record<string, unknown> });
          return hostAnswer(method, params as Record<string, unknown>);
        },
      },
    }),
    useCapability: () => ({ state: "available" }),
    useLaserState: (selector: (state: unknown) => unknown) => selector({ sessions, agents: { snapshot: { agents: [] } } } as never),
  };
});

// ------------------------------------------------------------------ fixtures

const TASK_SOURCE = {
  authority: "task" as const,
  entityId: "e-task-44",
  kind: "task" as const,
  key: "TASK-44",
  revisionId: "e-task-44r1",
  digest: "a".repeat(64),
  title: "The export list matches the design",
};

const DESIGN_SOURCE = {
  authority: "design" as const,
  entityId: "e-design-7",
  kind: "design" as const,
  key: "DES-7",
  revisionId: "e-design-7r3",
  digest: "d".repeat(64),
  title: "Export list",
};

const visual = (over: Partial<VerificationCriterion> = {}): VerificationCriterion => ({
  id: "design:visual:0",
  authority: "design",
  kind: "visual",
  text: "The export list renders as the design says, in both themes.",
  required: true,
  machineVerifiable: false,
  source: DESIGN_SOURCE,
  ...over,
});

function report(criteria: VerificationCriterion[]): VerificationReport {
  return {
    version: 1,
    runId: "ver_0001",
    task: TASK_SOURCE,
    startedAt: "2026-03-01T09:00:00.000Z",
    endedAt: "2026-03-01T09:05:00.000Z",
    authorities: [TASK_SOURCE, DESIGN_SOURCE],
    criteria,
    commands: [],
    findings: criteria.map((criterion) => ({
      criterionId: criterion.id,
      outcome: "needs_person" as const,
      detail: "Nothing has been accepted as native visual evidence yet.",
      evidenceIds: [],
    })),
    deviations: [],
    blockers: [],
    personDecisions: [],
    converged: false,
    outcome: "blocked",
    summary: "0 of 1 satisfied · 1 waiting on you",
    truncated: [],
  };
}

const APP_REPO = {
  repositoryId: "repo_app",
  name: "app",
  commit: "1".repeat(40),
  ref: checkpointRef("k1", 4),
};
const DOCS_REPO = {
  repositoryId: "repo_docs",
  name: "docs",
  commit: "2".repeat(40),
  ref: checkpointRef("k1", 4),
};

/** A Task with one attempt that checkpointed in one or two repositories. */
function taskDetail(options: { repos?: Array<typeof APP_REPO>; hasReport?: boolean; targetUnavailable?: boolean } = {}): Detail {
  const repos = options.repos ?? [APP_REPO];
  return detail({
    entityId: "e-task-44",
    kind: "task",
    number: 44,
    state: "in_progress",
    body: taskBody() as unknown as ProjectWorkBody,
    executionLinks: [
      executionLink({
        linkId: "x1",
        targetId: SESSION.id,
        attempt: 1,
        ...(options.targetUnavailable ? { targetUnavailable: true } : {}),
        repositories: repos.map((repo) =>
          attemptRepository({
            repositoryId: repo.repositoryId,
            name: repo.name,
            checkpoints: [
              { turn: 3, ref: checkpointRef("k1", 3), commitObjectId: repo.commit.replace(/^./, "9") },
              { turn: 4, ref: repo.ref, commitObjectId: repo.commit, createdAt: "2026-03-01T08:59:00.000Z" },
            ],
          }),
        ),
      }),
    ],
    evidence:
      options.hasReport === false
        ? []
        : [
            evidence({
              evidenceId: "evd_1",
              kind: "verification",
              role: "supporting",
              outcome: "inconclusive",
              summary: "Verification: 0 of 1 satisfied",
              blobId: "blb_1",
            }),
          ],
  });
}

const checkpointList = (over: Partial<CheckpointList> = {}): CheckpointList => ({
  path: SESSION.path,
  retention: "200",
  checkpoints: [
    {
      turn: 4,
      ref: APP_REPO.ref,
      commit: APP_REPO.commit,
      createdAt: "2026-03-01T08:59:00.000Z",
      repos: [
        { repo: "/work/app", ref: APP_REPO.ref, commit: APP_REPO.commit },
        { repo: "/work/app/docs", ref: DOCS_REPO.ref, commit: DOCS_REPO.commit },
      ],
    },
  ],
  ...over,
});

// ------------------------------------------------------------------ harness

let root: Root;
let container: HTMLDivElement;
let storeCalls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }>;
let blob: VerificationReport | undefined;
let linkFails: string | undefined;

const settle = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeStore = (): ProjectWorkStore => {
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: unknown) => {
      storeCalls.push({ method, params: params as Record<string, unknown> });
      if (method === "project/work/blob/read") {
        if (!blob) throw new Error("no blob");
        return {
          blobId: "blb_1",
          mediaType: VERIFICATION_REPORT_MEDIA_TYPE,
          digest: "c".repeat(64),
          totalBytes: 1,
          offset: 0,
          bytes: 1,
          data: Buffer.from(JSON.stringify(blob), "utf8").toString("base64"),
        };
      }
      if (method === "project/work/link") {
        if (linkFails !== undefined) throw new Error(linkFails);
        return { seq: 2, link: { type: "evidence" } };
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

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => (node.textContent ?? "").includes(label));
const dialog = (): HTMLElement | null => document.body.querySelector("[data-slot='native-acceptance']");
/** The confirming control inside the dialog, never the action that opens it. */
const confirmButton = (): HTMLButtonElement | null => document.body.querySelector("[data-slot='native-acceptance-confirm']");
const openButton = (): HTMLButtonElement | null => document.body.querySelector("[data-slot='native-acceptance-open']");
const links = () => storeCalls.filter((call) => call.method === "project/work/link");

const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await settle();
  });
};

const setValue = async (element: Element | null | undefined, value: string): Promise<void> => {
  expect(element).toBeTruthy();
  const node = element as HTMLInputElement | HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  });
};

const checkbox = (): HTMLInputElement | null => document.body.querySelector("input[type='checkbox']");
const confirmField = (): HTMLInputElement | null => document.body.querySelector("input[aria-label^='Type ']");
const checkpointSelect = (): HTMLSelectElement | null => document.body.querySelector("select[aria-label='Checkpoint you looked at']");
const repositorySelect = (): HTMLSelectElement | null => document.body.querySelector("select[aria-label='Repository']");

const mount = async (value: Detail, store: ProjectWorkStore): Promise<void> => {
  await act(async () => {
    root.render(<VerificationPanel store={store} detail={value} cwd="/work/app" pollMs={1_000} />);
    await settle(12);
  });
};

/** Open the dialog, attest and type the confirmation word. */
const confirmFor = async (word: string): Promise<void> => {
  await click(openButton());
  await click(checkbox());
  await setValue(confirmField(), word);
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  storeCalls = [];
  hostCalls = [];
  sessions = [SESSION];
  blob = undefined;
  linkFails = undefined;
  hostAnswer = async (method) => (method === "pi/project/checkpoint/list" ? checkpointList() : {});
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// ------------------------------------------------------------------ tests

describe("when a review cannot be recorded", () => {
  it("shows the action disabled and says what to do, rather than hiding it", async () => {
    await mount(taskDetail({ hasReport: false }), makeStore());
    expect(openButton()?.disabled).toBe(true);
    expect(text()).toContain("Verify this task first");
    expect(links()).toHaveLength(0);
  });

  it("says so when a run checked nothing visual", async () => {
    blob = report([
      { ...visual(), id: "task:command:0", kind: "command", authority: "task", source: TASK_SOURCE, machineVerifiable: true, command: "pnpm test" },
    ]);
    await mount(taskDetail(), makeStore());
    expect(openButton()?.disabled).toBe(true);
    expect(text()).toContain("no design or task revision to accept a build against");
  });

  it("says so when no attempt has recorded a checkpoint yet", async () => {
    blob = report([visual()]);
    const bare = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
      evidence: [
        evidence({ evidenceId: "evd_1", kind: "verification", role: "supporting", outcome: "inconclusive", summary: "v", blobId: "blb_1" }),
      ],
    });
    await mount(bare, makeStore());
    expect(openButton()?.disabled).toBe(true);
    expect(text()).toContain("No attempt has recorded a checkpoint in a repository yet");
  });
});

describe("recording one", () => {
  it("writes the exact tuple the host recorded from git, as a person's acceptance", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    await click(confirmButton());

    expect(links()).toHaveLength(1);
    const params = links()[0]!.params as {
      projectId: string;
      expectedRevisionId: string;
      link: Record<string, unknown> & { verifiedAt: { repositoryId: string; state: Record<string, unknown>; acceptance: unknown } };
    };
    // The subject is the Design revision the run read, not the Task.
    expect(params.link.entityId).toBe("e-design-7");
    expect(params.link.revisionId).toBe("e-design-7r3");
    expect(params.expectedRevisionId).toBe("e-design-7r3");
    expect(params.link.kind).toBe("person_acceptance");
    expect(params.link.role).toBe("acceptance");
    expect(params.link.outcome).toBe("passed");
    expect(params.link.verifiedAt.repositoryId).toBe("repo_app");
    expect(params.link.verifiedAt.state).toEqual({
      vcs: "git",
      objectFormat: "sha1",
      commitObjectId: APP_REPO.commit,
      checkpointId: APP_REPO.ref,
    });
    // The marker is a request for the host's action, and all this surface sends.
    expect(params.link.verifiedAt.acceptance).toEqual({ kind: "checkpoint_preview" });
    // Which attempt's work this checkpoint is, reported from the row itself so
    // the host can work out the sources the review rests on (M21-T19).
    expect((params.link.verifiedAt as { attempt?: unknown }).attempt).toEqual({
      taskEntityId: "e-task-44",
      executionLinkId: "x1",
    });
  });

  it("refuses a checkpoint that two attempts both recorded, rather than picking one", async () => {
    blob = report([visual()]);
    // The same repository, the same ref and the same commit, recorded by two
    // attempts: there is no honest answer to "whose work is this".
    const twice = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
      executionLinks: [
        executionLink({
          linkId: "x1",
          targetId: SESSION.id,
          attempt: 1,
          repositories: [
            attemptRepository({
              repositoryId: APP_REPO.repositoryId,
              name: APP_REPO.name,
              checkpoints: [{ turn: 4, ref: APP_REPO.ref, commitObjectId: APP_REPO.commit }],
            }),
          ],
        }),
        executionLink({
          linkId: "x2",
          targetId: SESSION.id,
          attempt: 2,
          repositories: [
            attemptRepository({
              repositoryId: APP_REPO.repositoryId,
              name: APP_REPO.name,
              checkpoints: [{ turn: 4, ref: APP_REPO.ref, commitObjectId: APP_REPO.commit }],
            }),
          ],
        }),
      ],
      evidence: [
        evidence({
          evidenceId: "evd_1",
          kind: "verification",
          role: "supporting",
          outcome: "inconclusive",
          summary: "Verification: 0 of 1 satisfied",
          blobId: "blb_1",
        }),
      ],
    });
    await mount(twice, makeStore());
    await click(openButton());
    await click(checkbox());
    await setValue(confirmField(), "DES-7");
    expect(text(), "the surface says why, in a sentence").toContain("More than one attempt recorded this checkpoint");
    expect(confirmButton()?.disabled, "and records nothing").toBe(true);
    await click(confirmButton());
    expect(links()).toHaveLength(0);
  });

  it("names the repository, the checkpoint, the commit and the revision on screen", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await click(openButton());
    const tuple = document.body.querySelector("[data-slot='native-acceptance-tuple']")?.textContent ?? "";
    expect(tuple).toContain("app");
    expect(tuple).toContain(APP_REPO.ref);
    expect(tuple).toContain(APP_REPO.commit);
    expect(tuple).toContain("DES-7 at e-design-7r3");
  });

  it("records a task's own revision when the criterion is the task's", async () => {
    blob = report([{ ...visual(), id: "task:visual:0", authority: "task", source: TASK_SOURCE }]);
    await mount(taskDetail(), makeStore());
    await confirmFor("TASK-44");
    await click(confirmButton());

    const params = links()[0]!.params as { link: { entityId: string; revisionId: string } };
    expect(params.link.entityId).toBe("e-task-44");
    expect(params.link.revisionId).toBe("e-task-44r1");
  });

  it("uses the chosen repository's own commit, never another repository's", async () => {
    blob = report([visual()]);
    await mount(taskDetail({ repos: [APP_REPO, DOCS_REPO] }), makeStore());
    await click(openButton());
    await setValue(repositorySelect(), "repo_docs");
    await click(checkbox());
    await setValue(confirmField(), "DES-7");
    await click(confirmButton());

    const params = links()[0]!.params as { link: { verifiedAt: { repositoryId: string; state: { commitObjectId: string } } } };
    expect(params.link.verifiedAt.repositoryId).toBe("repo_docs");
    expect(params.link.verifiedAt.state.commitObjectId).toBe(DOCS_REPO.commit);
    expect(params.link.verifiedAt.state.commitObjectId).not.toBe(APP_REPO.commit);
  });

  it("reads the task again afterwards, so the next run finds the evidence", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    storeCalls.length = 0;
    await confirmFor("DES-7");
    await click(confirmButton());
    expect(storeCalls.some((call) => call.method === "project/work/get" || call.method === "project/work/list")).toBe(true);
    expect(dialog()).toBeNull();
  });
});

describe("what writes nothing", () => {
  it("cancelling", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    await click(button("Cancel"));
    expect(links()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  it("an attestation nobody ticked, or a confirmation word that is not the key", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await click(openButton());
    await setValue(confirmField(), "DES-7");
    expect(confirmButton()?.disabled).toBe(true);

    await click(checkbox());
    await setValue(confirmField(), "des-7 ");
    expect(confirmButton()?.disabled).toBe(true);
    await click(confirmButton());
    expect(links()).toHaveLength(0);
  });

  it("Enter in the typed field, which confirms nothing", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    const field = confirmField()!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      field.dispatchEvent(event);
      await settle();
    });
    expect(event.defaultPrevented).toBe(true);
    expect(links()).toHaveLength(0);
  });

  it("a checkpoint the repository no longer has", async () => {
    blob = report([visual()]);
    hostAnswer = async (method) => (method === "pi/project/checkpoint/list" ? checkpointList({ checkpoints: [] }) : {});
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    expect(text()).toContain("no longer in the repository");
    expect(confirmButton()?.disabled).toBe(true);
    await click(confirmButton());
    expect(links()).toHaveLength(0);
  });

  it("a checkpoint whose ref now points somewhere else", async () => {
    blob = report([visual()]);
    hostAnswer = async (method) =>
      method === "pi/project/checkpoint/list"
        ? checkpointList({
            checkpoints: [
              { turn: 4, ref: APP_REPO.ref, commit: "f".repeat(40), createdAt: "2026-03-01T08:59:00.000Z", repos: [{ repo: "/work/app", ref: APP_REPO.ref, commit: "f".repeat(40) }] },
            ],
          })
        : {};
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    expect(text()).toContain("no longer points at the state recorded here");
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("a refusal from the host, which stays on screen and records nothing", async () => {
    blob = report([visual()]);
    linkFails = "DES-7 has moved on since that preview was made.";
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    await click(confirmButton());
    expect(links()).toHaveLength(1);
    expect(text()).toContain("has moved on since that preview was made");
    expect(text()).toContain("Nothing was recorded.");
    expect(dialog()).toBeTruthy();
  });
});

describe("what invalidates a confirmation", () => {
  it("choosing a different checkpoint", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    expect(confirmButton()?.disabled).toBe(false);

    const select = checkpointSelect()!;
    const other = [...select.options].find((option) => option.value !== select.value)!;
    await setValue(select, other.value);

    expect(checkbox()?.checked).toBe(false);
    expect(confirmField()?.value).toBe("");
    expect(confirmButton()?.disabled).toBe(true);
    await click(confirmButton());
    expect(links()).toHaveLength(0);
  });
});

describe("asynchronous answers", () => {
  it("keeps only the newest liveness answer, so a stale one cannot unblock or block a choice", async () => {
    blob = report([visual()]);
    let calls = 0;
    // The first answer is slow and says the checkpoint is gone; it is about
    // the checkpoint the person has already moved away from.
    hostAnswer = async (method) => {
      if (method !== "pi/project/checkpoint/list") return {};
      calls += 1;
      if (calls === 1) {
        await settle(60);
        return checkpointList({ checkpoints: [] });
      }
      return checkpointList({
        checkpoints: [
          {
            turn: 3,
            ref: checkpointRef("k1", 3),
            commit: "9" + APP_REPO.commit.slice(1),
            createdAt: "2026-03-01T08:58:00.000Z",
            repos: [{ repo: "/work/app", ref: checkpointRef("k1", 3), commit: "9" + APP_REPO.commit.slice(1) }],
          },
        ],
      });
    };

    await mount(taskDetail(), makeStore());
    await click(openButton());
    const select = checkpointSelect()!;
    const other = [...select.options].find((option) => option.value !== select.value)!;
    await setValue(select, other.value);
    await act(async () => {
      await settle(90);
    });

    // The slow "it is gone" answer belonged to the other checkpoint.
    expect(text()).not.toContain("no longer in the repository");
    await click(checkbox());
    await setValue(confirmField(), "DES-7");
    expect(confirmButton()?.disabled).toBe(false);
  });

  it("asks the conversation this attempt ran in, for the checkpoint being confirmed", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await click(openButton());
    const asked = hostCalls.filter((call) => call.method === "pi/project/checkpoint/list");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.params).toEqual({ cwd: "/work/app", path: SESSION.path });
  });

  it("asks once per checkpoint, however often the surface around it re-renders", async () => {
    // The host connection is re-bound on every render of the panel above, so
    // a dialog that watched its identity would ask git again for every answer
    // it got. Re-rendering with a brand-new request function proves it does
    // not: typing, ticking and a fresh connection are not new questions.
    blob = report([visual()]);
    const store = makeStore();
    const value = taskDetail();
    const render = async (): Promise<void> => {
      await act(async () => {
        root.render(
          <NativeAcceptanceDialog
            store={store}
            detail={value}
            report={blob}
            sessions={sessions}
            cwd="/work/app"
            request={async (method, params) => {
              hostCalls.push({ method, params: params as unknown as Record<string, unknown> });
              return checkpointList();
            }}
            open
            onOpenChange={() => {}}
          />,
        );
        await settle(12);
      });
    };

    await render();
    await click(checkbox());
    await setValue(confirmField(), "DES-7");
    await render();
    await render();
    await act(async () => {
      await settle(30);
    });

    expect(hostCalls.filter((call) => call.method === "pi/project/checkpoint/list")).toHaveLength(1);
    expect(confirmButton()?.disabled).toBe(false);
  });

  it("stays usable when the checkpoint list cannot be read, because the host is the authority", async () => {
    blob = report([visual()]);
    hostAnswer = async (method) => {
      if (method === "pi/project/checkpoint/list") throw new Error("no worker here");
      return {};
    };
    await mount(taskDetail(), makeStore());
    await confirmFor("DES-7");
    expect(confirmButton()?.disabled).toBe(false);
  });
});

describe("honesty about what this is", () => {
  it("says the app was not rendered here, and asks for the person's own attestation", async () => {
    blob = report([visual()]);
    await mount(taskDetail(), makeStore());
    await click(openButton());
    const body = dialog()?.textContent ?? "";
    expect(body).toContain("Nothing here renders your app");
    expect(body).toContain("a file diff is not a running one");
    expect(checkbox()?.getAttribute("aria-label")).toContain("I opened the build at this checkpoint");
  });
});
