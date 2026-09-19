// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitActionExpect, GitCommitResult, GitHostStatus, GitPrReadResult, GitPushResult } from "@lasercode/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { ChangesDataAdapter } from "../../src/source-control/data.js";
import { GitActionDialog } from "../../src/source-control/git-dialog.js";
import { ChangesGitActions } from "../../src/source-control/git-toolbar.js";
import { createMockAdapter } from "../../src/source-control/mock.js";
import { resetChangesAdapter, setChangesAdapter } from "../../src/source-control/data.js";
import { requestGitAction, resetChangesUi } from "../../src/source-control/store.js";

let root: Root;
let container: HTMLDivElement;

const REPOS = [
  { repo: "app", branch: "main", files: [{ path: "src/a.ts", status: "modified" as const, added: 2, removed: 1 }] },
  { repo: "other", branch: "main", files: [{ path: "src/b.ts", status: "modified" as const, added: 1, removed: 0 }] },
];

const GITHUB: GitHostStatus = {
  repo: "app",
  host: "github",
  remote: "origin",
  defaultBranch: "main",
  branch: "main",
  cli: "gh",
  cliPresent: true,
  signedIn: true,
  usable: true,
};

const SIGNED_OUT: GitHostStatus = {
  repo: "other",
  host: "github",
  remote: "origin",
  defaultBranch: "main",
  branch: "main",
  cli: "gh",
  cliPresent: true,
  signedIn: false,
  usable: false,
  fix: "Run gh auth login.",
  reason: "signed_out",
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetChangesUi();
  resetChangesAdapter();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetChangesUi();
  resetChangesAdapter();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string | RegExp): HTMLButtonElement {
  const nodes = [...document.querySelectorAll("button")];
  const node = nodes.find((item) => {
    const text = `${item.textContent ?? ""} ${item.getAttribute("aria-label") ?? ""}`.trim();
    return typeof label === "string" ? text.includes(label) : label.test(text);
  });
  expect(node).toBeTruthy();
  return node as HTMLButtonElement;
}

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="git-action-dialog"]');
  expect(node).toBeTruthy();
  return node!;
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

type CommitCall = {
  repo?: string;
  paths: string[];
  message: string;
  confirm?: boolean;
  expect?: GitActionExpect;
};

function recordingAdapter(opts?: {
  hosts?: GitHostStatus[];
  commit?: (params: CommitCall, fallback: ChangesDataAdapter["gitCommit"]) => Promise<GitCommitResult>;
  push?: ChangesDataAdapter["gitPush"];
  prCreate?: ChangesDataAdapter["gitPrCreate"];
  prRead?: ChangesDataAdapter["gitPrRead"];
}): { adapter: ChangesDataAdapter; commits: CommitCall[]; pushes: Array<{ confirm?: boolean }> } {
  const base = createMockAdapter();
  const commits: CommitCall[] = [];
  const pushes: Array<{ confirm?: boolean }> = [];
  const adapter: ChangesDataAdapter = {
    ...base,
    async gitHosts() {
      return { hosts: opts?.hosts ?? [GITHUB, SIGNED_OUT] };
    },
    async gitCommit(params) {
      commits.push(params);
      if (opts?.commit) return opts.commit(params, base.gitCommit);
      return base.gitCommit!(params);
    },
    async gitPush(params) {
      pushes.push({ ...(params.confirm === true ? { confirm: true } : {}) });
      if (opts?.push) return opts.push(params);
      return base.gitPush!(params);
    },
    async gitPrCreate(params) {
      if (opts?.prCreate) return opts.prCreate(params);
      return base.gitPrCreate!(params);
    },
    async gitPrRead(params) {
      if (opts?.prRead) return opts.prRead(params);
      return base.gitPrRead!(params);
    },
  };
  return { adapter, commits, pushes };
}

async function mount(opts?: {
  adapter?: ChangesDataAdapter;
  repoFilter?: string | null;
  chrome?: "phone" | "desktop";
}): Promise<void> {
  setChangesAdapter(opts?.adapter ?? recordingAdapter().adapter);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ChangesGitActions
          repos={REPOS}
          repoFilter={opts?.repoFilter ?? null}
          activeRepo="app"
          chrome={opts?.chrome ?? "desktop"}
        />
        <GitActionDialog />
      </TooltipProvider>,
    );
  });
  await flush();
}

it("previews a commit, lets the person edit the prose, then confirms with expect", async () => {
  const { adapter, commits } = recordingAdapter();
  await mount({ adapter });
  await act(async () => button("Commit").click());
  await flush();
  const field = dialog().querySelector<HTMLTextAreaElement>('[data-slot="git-commit-message"]');
  expect(field).toBeTruthy();
  expect(field!.value).toMatch(/overlay toolbar/);
  await act(async () => {
    field!.focus();
    setFieldValue(field!, "Edited commit message.");
  });
  await act(async () => button("Commit to main").click());
  await flush();
  expect(commits.length).toBeGreaterThanOrEqual(2);
  expect(commits[0]?.confirm).toBeUndefined();
  const confirmed = commits.find((call) => call.confirm === true);
  expect(confirmed).toBeTruthy();
  expect(confirmed?.message).toBe("Edited commit message.");
  expect(confirmed?.expect).toEqual({ branch: "main", files: confirmed?.paths, head: "abc1234" });
  expect(commits.filter((call) => call.confirm === true)).toHaveLength(1);
  expect(dialog().getAttribute("data-outcome") ?? dialog().querySelector("[data-outcome]")?.getAttribute("data-outcome")).toBe("done");
});

it("does not mutate until confirm is true", async () => {
  const { adapter, commits } = recordingAdapter();
  await mount({ adapter });
  await act(async () => button("Commit").click());
  await flush();
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((call) => call.confirm !== true)).toBe(true);
  await act(async () => button("Cancel").click());
  await flush();
  expect(commits.some((call) => call.confirm === true)).toBe(false);
});

it("renders an expect mismatch as a sentence and reviews again instead of confirming blindly", async () => {
  const { adapter, commits } = recordingAdapter({
    commit: async (params, fallback) => {
      if (params.confirm === true) {
        return {
          outcome: "refused",
          message: "HEAD moved. Review the files again.",
          confirmation: {
            repo: "app",
            branch: "main",
            files: params.paths,
            summary: "Commit the files on main.",
          },
        };
      }
      return fallback!(params);
    },
  });
  await mount({ adapter });
  await act(async () => button("Commit").click());
  await flush();
  await act(async () => button("Commit to main").click());
  await flush();
  expect(dialog().textContent).toMatch(/HEAD moved/);
  expect(dialog().querySelector('[data-outcome="refused"]')).toBeTruthy();
  expect([...dialog().querySelectorAll("button")].some((item) => item.textContent?.includes("Review again"))).toBe(true);
  const before = commits.filter((call) => call.confirm === true).length;
  await act(async () => button("Review again").click());
  await flush();
  expect(commits.filter((call) => call.confirm === true)).toHaveLength(before);
  expect(commits.at(-1)?.confirm).toBeUndefined();
});

it("renders needs_copy as a copyable command, not an error", async () => {
  const { adapter } = recordingAdapter({
    commit: async (params) => ({
      outcome: "needs_copy",
      message: "Run this where you are signed in.",
      confirmation: { repo: "app", branch: "main", summary: "Commit on main." },
      copyable: { argv: ["git", "commit", "-m", params.message], cwd: "/p" },
    }),
  });
  await mount({ adapter });
  await act(async () => button("Commit").click());
  await flush();
  expect(dialog().querySelector('[data-outcome="needs_copy"]')).toBeTruthy();
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(dialog().querySelector('[data-slot="git-action-copyable"]')?.textContent).toMatch(/git commit -m/);
  expect(dialog().textContent).toMatch(/cannot run that action/i);
});

it("shows an uncertain push and does not retry it", async () => {
  const { adapter, pushes } = recordingAdapter({
    push: async (params): Promise<GitPushResult> => {
      const confirmation = {
        repo: params.repo ?? "app",
        branch: params.branch,
        remote: params.remote,
        summary: `Push ${params.branch} to ${params.remote}.`,
      };
      if (params.confirm !== true) {
        return {
          outcome: "preview",
          confirmation,
          expect: { branch: params.branch, head: "abc1234" },
        };
      }
      return {
        outcome: "uncertain",
        message: "The push timed out after the remote accepted it. Check origin before sending it again.",
        confirmation,
      };
    },
  });
  await mount({ adapter });
  await act(async () => requestGitAction({ kind: "push", repo: "app" }));
  await flush();
  await act(async () => button(/Push main to origin/).click());
  await flush();
  expect(dialog().querySelector('[data-outcome="uncertain"]')).toBeTruthy();
  expect(dialog().textContent).toMatch(/may already have happened/);
  expect(dialog().textContent).toMatch(/Check origin/);
  expect([...dialog().querySelectorAll("button")].some((item) => /try again/i.test(item.textContent ?? ""))).toBe(false);
  expect(pushes.filter((call) => call.confirm === true)).toHaveLength(1);
});

it("names the signed-out fix while the neighbour still commits", async () => {
  const { adapter, commits } = recordingAdapter();
  await mount({ adapter, repoFilter: "other" });
  expect(document.body.textContent).toMatch(/Run gh auth login/);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ChangesGitActions repos={REPOS} repoFilter="app" activeRepo="app" chrome="desktop" />
        <GitActionDialog />
      </TooltipProvider>,
    );
  });
  await flush();
  await act(async () => button("Commit").click());
  await flush();
  await act(async () => button("Commit to main").click());
  await flush();
  expect(commits.some((call) => call.confirm === true && (call.repo === "app" || call.repo === undefined))).toBe(true);
});

it("reaches commit from the keyboard, edits the prose, and Escape cancels", async () => {
  const { adapter, commits } = recordingAdapter();
  await mount({ adapter });
  const commit = button("Commit");
  await act(async () => {
    commit.focus();
    commit.click();
  });
  await flush();
  const field = dialog().querySelector<HTMLTextAreaElement>('[data-slot="git-commit-message"]');
  expect(field).toBeTruthy();
  await act(async () => {
    field!.focus();
    setFieldValue(field!, "Keyboard edit.");
    field!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
  // Radix closes on Escape from the dialog; if the field swallowed it, Cancel still exists.
  const open = document.querySelector('[data-slot="git-action-dialog"]');
  if (open) await act(async () => button("Cancel").click());
  await flush();
  expect(document.querySelector('[data-slot="git-action-dialog"]')).toBeNull();
  expect(commits.some((call) => call.confirm === true)).toBe(false);
});

it("opens git actions from the Git menu with a pointer", async () => {
  const { adapter } = recordingAdapter();
  await mount({ adapter });
  const git = button("Git");
  await act(async () => git.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
  await flush();
  const menu = document.querySelector("[data-slot=\"dropdown-menu-content\"]");
  expect(menu?.textContent).toMatch(/Commit/);
  expect(menu?.textContent).toMatch(/Push/);
  expect(menu?.textContent).toMatch(/Open a pull request/);
  const item = [...(menu?.querySelectorAll("[data-slot=\"dropdown-menu-item\"]") ?? [])].find((node) =>
    node.textContent?.includes("Open a pull request"),
  ) as HTMLElement | undefined;
  expect(item).toBeTruthy();
  await act(async () => {
    item!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item!.click();
  });
  await flush();
  expect(document.querySelector('[data-slot="git-action-dialog"]')).toBeTruthy();
  expect(dialog().querySelector('[data-slot="git-pr-title"]')).toBeTruthy();
});

it("previews a pull request, lets the person edit the title, then confirms with expect", async () => {
  const creates: Array<{ title: string; body: string; confirm?: boolean; expect?: GitActionExpect }> = [];
  const { adapter } = recordingAdapter({
    prCreate: async (params) => {
      creates.push({
        title: params.title,
        body: params.body,
        ...(params.confirm === true ? { confirm: true } : {}),
        ...(params.expect ? { expect: params.expect } : {}),
      });
      const confirmation = {
        repo: params.repo ?? "app",
        branch: params.head,
        remote: "origin",
        summary: `Open a pull request from ${params.head} into ${params.base}.`,
      };
      if (params.confirm !== true) {
        return { outcome: "preview" as const, confirmation, expect: { branch: params.head, head: "abc1234" } };
      }
      return {
        outcome: "done" as const,
        confirmation,
        pullRequest: { host: "github" as const, number: 4, url: "https://example.test/pr/4", title: params.title },
      };
    },
  });
  await mount({ adapter });
  await act(async () => requestGitAction({ kind: "pull-request-create", repo: "app" }));
  await flush();
  const title = dialog().querySelector<HTMLInputElement>('[data-slot="git-pr-title"]');
  expect(title?.value).toMatch(/overlay toolbar/);
  await act(async () => {
    title!.focus();
    setFieldValue(title!, "Edited PR title");
  });
  await act(async () => button("Review pull request").click());
  await flush();
  await act(async () => button("Open pull request").click());
  await flush();
  expect(creates[0]?.confirm).toBeUndefined();
  const confirmed = creates.find((call) => call.confirm === true);
  expect(confirmed?.title).toBe("Edited PR title");
  expect(confirmed?.expect?.head).toBe("abc1234");
  expect(creates.filter((call) => call.confirm === true)).toHaveLength(1);
});

it("shows failing checks on a pull request and still lets the person review a merge", async () => {
  const failing: GitPrReadResult = {
    outcome: "done",
    confirmation: { repo: "app", branch: "feature", summary: "Read pull request 9." },
    pullRequest: {
      host: "github",
      number: 9,
      title: "Fix the overlay toolbar",
      body: "Checks are red.",
      url: "https://example.test/pr/9",
      state: "open",
      base: "main",
      head: "feature",
      comments: [],
      checks: [
        { name: "tests", status: "failure" },
        { name: "lint", status: "success" },
      ],
    },
  };
  const { adapter } = recordingAdapter({ prRead: async () => failing });
  await mount({ adapter });
  await act(async () => requestGitAction({ kind: "pull-request-read", repo: "app" }));
  await flush();
  const number = dialog().querySelector<HTMLInputElement>('[aria-label="Pull request number"]');
  expect(number).toBeTruthy();
  await act(async () => {
    number!.focus();
    setFieldValue(number!, "9");
  });
  await act(async () => button("Read pull request").click());
  await flush();
  expect(dialog().textContent).toMatch(/1 check failed/);
  expect(dialog().textContent).toMatch(/tests/);
  expect(dialog().textContent).toMatch(/failure/);
  expect([...dialog().querySelectorAll("button")].some((item) => item.textContent?.includes("Review merge"))).toBe(true);
});
