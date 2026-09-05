/**
 * The thread column. The shell renders `<Thread/>` inside `<LaserProvider>`.
 */
export { Thread, type ThreadProps } from "./Thread.js";
export { ThreadSlotsProvider, useThreadSlots, type ThreadSlots } from "./thread-slots.js";
export { Composer } from "./Composer.js";
export { StatusLine } from "./StatusLine.js";
export { ProjectLine } from "./ProjectLine.js";
export { ToolGroup, type ToolGroupProps } from "@/components/assistant-ui/elements/tool-group.aui";
export { EmptyState } from "./EmptyState.js";
// The queue chips, the model picker and the thinking control are catalog
// elements now (docs/ux-elements.md): `elements/message-queue`,
// `elements/model-selector`, `elements/reasoning-effort`.
export { ComposerQueue, MessageQueue, QueuedChip } from "@/components/assistant-ui/elements/message-queue";
export { SessionModelSelector } from "@/components/assistant-ui/elements/model-selector";
export { ReasoningEffort, ThinkingEffort, THINKING_LEVELS } from "@/components/assistant-ui/elements/reasoning-effort";
export { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
export { ToolRow } from "./ToolRow.js";
export { TerminalBlock, type TerminalBlockProps } from "@/components/assistant-ui/elements/terminal-block";
export { CodeDiff, CodeDiffRows, DiffStat, type CodeDiffProps } from "@/components/assistant-ui/elements/code-diff";
export { AssistantMessage, Notice, ThreadMessage, UserMessage } from "./messages.js";
export {
  MAX_DIFF_LINES,
  diffLines,
  diffStats,
  diffViewForTool,
  parseUnifiedPatch,
  type DiffHunk,
  type DiffLine,
  type DiffLineKind,
  type DiffView,
} from "./diff.js";
export {
  oneLine,
  parseBashOutput,
  pretty,
  resultDetails,
  resultText,
  shortPath,
  summarizeTool,
  toolBody,
  toolKind,
  type ToolBody,
  type ToolKind,
  type ToolSummary,
} from "./tool-summary.js";
export { elapsedOf, markDone, markRunning, resetTiming, useCountdown, useElapsed, useTick } from "./timing.js";
export {
  summarizeToolGroup,
  toolGroupDefaultOpen,
  type ToolGroupFamily,
  type ToolGroupMember,
  type ToolGroupSummary,
} from "./tool-groups.js";
export { EMPTY_TURN, applyTurnUpdate, turnElapsed, updateTime, type TurnStats } from "./turn-stats.js";
export {
  FILE_CHANGING_TOOLS,
  branchOfUpstream,
  deltaParts,
  githubCompareUrl,
  parseGitHubRemote,
  pullRequestCommands,
  type GitHubRemote,
} from "./project-git.js";
export { useSessionUpdates } from "./session-updates.js";
export { continuationsOf, laterUserMessages, leafOf, userEntryAt, userEntryIds, type EntryLike } from "./entries.js";
