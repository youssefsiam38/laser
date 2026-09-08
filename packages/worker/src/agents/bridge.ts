/**
 * The harness ↔ companion-extension contract, as the worker sees it.
 *
 * The shapes are the extension's own (`packages/pi-extension/src/agents-bridge.ts`),
 * re-exported type-only: they are product-protocol vocabulary, never engine
 * types, so `driver.ts` can name them without breaking the seam test.
 */
export type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  BackgroundWorkOptions,
  CompleteRunInput,
  CompleteRunResult,
  HarnessSessionRole,
  SendAgentMessageInput,
  SendAgentMessageResult,
  StartAgentInput,
  StartAgentResult,
  StopAgentInput,
  WaitForAgentsInput,
  WaitForAgentsResult,
} from "@lasercode/pi-extension";
