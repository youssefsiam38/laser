/**
 * The one data access module for the overlay. Everything else talks to this
 * adapter. The mock is the default until M18-T2 lands `pi/project/changes`
 * and friends; swapping is one call to `setChangesAdapter`.
 */
import type {
  AgentChangesContext,
  ChangesList,
  ChangesScope,
  FileDiffPage,
  FileSource,
} from "./contract.js";
import { createMockAdapter } from "./mock.js";

export type ChangesDataAdapter = {
  listChanges(scope: ChangesScope): Promise<ChangesList>;
  getFileDiff(scope: ChangesScope, repo: string, path: string, options?: { offset?: number }): Promise<FileDiffPage>;
  getFileSource?(scope: ChangesScope, repo: string, path: string, ref: "old" | "new"): Promise<FileSource | null>;
  getAgentContext?(runId: string): Promise<AgentChangesContext>;
};

let adapter: ChangesDataAdapter = createMockAdapter();

export function setChangesAdapter(next: ChangesDataAdapter): void {
  adapter = next;
}

export function getChangesAdapter(): ChangesDataAdapter {
  return adapter;
}

export function resetChangesAdapter(): void {
  adapter = createMockAdapter();
}
