/**
 * The agents feature's components (docs/agents.md): the Agents page, the live
 * map, and the shared pieces every surface reaches for. Each lane appends its
 * own exports here; nothing below imports across lanes.
 */

// Ending a run (Lane U2): the shell mounts `EndAgentDialog` once; a row menu,
// a run tab or a map node asks through `requestEndAgent(runId)`.
export { EndAgentDialog, END_AGENT_REASONS } from "./EndAgentDialog.js";
export { clearEndAgentRequest, requestEndAgent, useEndAgentRequest, type EndAgentRequest } from "./end-agent.js";
