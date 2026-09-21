/** The embedded project workspace (M21-T6, D-355). */
export { ProjectWorkBridge } from "./ProjectWorkBridge.js";
export { ProjectWorkControl, controlTooltip } from "./ProjectWorkControl.js";
export { ProjectWorkspace } from "./Workspace.js";
export { KeyTag, NeedsYouChip, StatusChip, TypeBadge, WorkIdentity } from "./KindBadge.js";
export { nextKeyFor } from "./CreateDialog.js";
export {
  clearWorkCreationRequest,
  startProjectWork,
  titleFromText,
  useWorkCreationRequest,
  WorkProjectPicker,
} from "./create-work.js";
export { useProjectWorkCommands, WORK_COMMAND_KINDS } from "./work-commands.js";
/** Quote a finding into the conversation's composer (M21-T7). */
export { onWorkQuote, quoteIntoComposer, WORK_QUOTE_EVENT, type WorkQuoteDetail } from "./quote.js";
