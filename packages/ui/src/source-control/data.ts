/**
 * The one data access module for the overlay. Everything else talks to this
 * adapter. The default refuses rather than inventing a working tree; tests and
 * the sandbox register the mock explicitly.
 */
import type {
  GitActionExpect,
  GitBranchResult,
  GitCommitResult,
  GitHostsResult,
  GitPrCheckoutResult,
  GitPrCreateResult,
  GitPrMergeResult,
  GitPrMergeMethod,
  GitProseKind,
  GitProseResult,
  GitPrReadResult,
  GitPrViewedResult,
  GitPushResult,
  WorkspaceShape,
} from "@lasercode/protocol";

import type {
  AgentChangesContext,
  ChangesList,
  ChangesScope,
  FileDiffPage,
  FileSource,
} from "./contract.js";
import { CHANGES_UNAVAILABLE } from "./errors.js";

export type ChangesDataAdapter = {
  listChanges(scope: ChangesScope): Promise<ChangesList>;
  getFileDiff(scope: ChangesScope, repo: string, path: string, options?: { offset?: number }): Promise<FileDiffPage>;
  getFileSource?(scope: ChangesScope, repo: string, path: string, ref: "old" | "new"): Promise<FileSource | null>;
  getWorkspace?(options?: { rescan?: boolean }): Promise<WorkspaceShape>;
  getAgentContext?(runId: string): Promise<AgentChangesContext>;
  gitHosts?(repos?: string[]): Promise<GitHostsResult>;
  gitProse?(params: { kind: GitProseKind; files: string[]; repo?: string; summary?: string }): Promise<GitProseResult>;
  gitCommit?(params: {
    repo?: string;
    paths: string[];
    message: string;
    confirm?: boolean;
    expect?: GitActionExpect;
  }): Promise<GitCommitResult>;
  gitPush?(params: {
    repo?: string;
    remote: string;
    branch: string;
    confirm?: boolean;
    expect?: GitActionExpect;
  }): Promise<GitPushResult>;
  gitBranch?(params: {
    repo?: string;
    name: string;
    base: string;
    checkout?: boolean;
    confirm?: boolean;
    expect?: GitActionExpect;
  }): Promise<GitBranchResult>;
  gitPrCreate?(params: {
    repo?: string;
    title: string;
    body: string;
    base: string;
    head: string;
    confirm?: boolean;
    expect?: GitActionExpect;
  }): Promise<GitPrCreateResult>;
  gitPrRead?(params: { repo?: string; number: number }): Promise<GitPrReadResult>;
  gitPrCheckout?(params: {
    repo?: string;
    number: number;
    confirm?: boolean;
    expect?: GitActionExpect;
  }): Promise<GitPrCheckoutResult>;
  gitPrMerge?(params: {
    repo?: string;
    number: number;
    method: GitPrMergeMethod;
    confirm?: boolean;
    expect?: GitActionExpect;
  }): Promise<GitPrMergeResult>;
  gitPrViewed?(params: {
    repo?: string;
    number: number;
    path: string;
    viewed: boolean;
  }): Promise<GitPrViewedResult>;
};

export type ChangesAdapterSource = "none" | "host" | "custom";

const unavailable = (): never => {
  throw new Error(CHANGES_UNAVAILABLE);
};

export const unavailableChangesAdapter: ChangesDataAdapter = {
  listChanges: async () => unavailable(),
  getFileDiff: async () => unavailable(),
};

let adapter: ChangesDataAdapter = unavailableChangesAdapter;
let adapterSource: ChangesAdapterSource = "none";

export function setChangesAdapter(next: ChangesDataAdapter, source: ChangesAdapterSource = "custom"): void {
  adapter = next;
  adapterSource = source;
}

export function getChangesAdapter(): ChangesDataAdapter {
  return adapter;
}

export function getChangesAdapterSource(): ChangesAdapterSource {
  return adapterSource;
}

export function resetChangesAdapter(): void {
  adapter = unavailableChangesAdapter;
  adapterSource = "none";
}
