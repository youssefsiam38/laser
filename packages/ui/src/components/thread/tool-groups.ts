/**
 * Pure helpers for the collapsed tool-group row (D-20 §4): what a run of
 * consecutive tool calls is called — "Ran 2 commands", "Edited 3 files",
 * "Read 5 files", "Searched 2 patterns" — and whether it should open by
 * default. No React, no DOM. Tested in test/thread/tool-groups.test.ts.
 */
import type { DiffStats } from "./diff.js";
import { mcpActiveLabel, mcpRowSummary, type McpToolInfo } from "./mcp-tools.js";
import { shortPath, summarizeTool, toolKind, type ToolKind } from "./tool-summary.js";

export type ActivityIconKind = ToolKind | "reasoning";

/** What the group needs to know about one call; a projection of the tool part. */
export interface ToolGroupMember {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly isError: boolean;
  /**
   * The member is a shell command that ran and came back non-zero
   * (`isNonZeroExit`). It is an error to the model, and the breakdown still
   * says so, but it is an ordinary result to the group: it does not tint the
   * aggregate, count towards its failures, or open it.
   */
  readonly nonZeroExit?: boolean;
  readonly running: boolean;
  /** An approval or interrupt is waiting on a person. */
  readonly awaiting: boolean;
  readonly cancelled: boolean;
  /** Full-source file changes, present only for a successfully completed edit/write. */
  readonly diffStats?: DiffStats | undefined;
  /**
   * Set when this call is an MCP one (docs/mcp.md). The aggregate then names
   * it the way its own row does — "Playwright · browser navigate", not the
   * registered `playwright_browser_navigate`.
   */
  readonly mcp?: McpToolInfo | undefined;
}

/** The family a group is named after. `mixed` = more than one family. */
export type ToolGroupFamily = "command" | "edit" | "write" | "read" | "search" | "list" | "other" | "reasoning" | "mixed";

export interface ToolGroupBreakdownItem {
  readonly family: Exclude<ToolGroupFamily, "mixed">;
  readonly iconKind: ActivityIconKind;
  /** A counted, past/present-tense action: "Read 3 files". */
  readonly label: string;
  /** Extra precision where the action count differs from its subject count. */
  readonly detail: string | undefined;
}

export interface ToolGroupSummary {
  readonly family: ToolGroupFamily;
  /** Icon to draw when nothing is running; the family's own, `Wrench` for mixed. */
  readonly iconKind: ActivityIconKind;
  /** Host Grotesk 500 label, e.g. "Ran 2 commands" or "Running 2 commands" while live. */
  readonly label: string;
  /** Typed fragment after the label: the live call while running, or "· 3 edits" when calls outnumber files. */
  readonly detail: string | undefined;
  readonly count: number;
  /** Something in the group actually broke. A non-zero shell exit does not. */
  readonly hasError: boolean;
  readonly hasDecision: boolean;
  readonly running: boolean;
  /** Exact current action for the live indicator: "Editing src/index.html". */
  readonly activeLabel: string | undefined;
  /** Mixed activity only: one counted item per family, in first-seen order. */
  readonly breakdown: readonly ToolGroupBreakdownItem[];
  /** Full-source changes across successfully completed edit/write members. */
  readonly diffStats?: DiffStats | undefined;
  /** Full list for the accessible name and the tooltip: one line per call. */
  readonly lines: readonly string[];
}

/** The family a tool name belongs to. */
export const toolFamily = (toolName: string): Exclude<ToolGroupFamily, "mixed"> => familyOf(toolKind(toolName));

/** Every uninterrupted tool run shares one chronological activity parent. */
export const toolGroupKey = (_toolName: string): string => "activity";

const familyOf = (kind: ToolKind): Exclude<ToolGroupFamily, "mixed" | "reasoning"> => {
  switch (kind) {
    case "bash":
      return "command";
    case "edit":
      return "edit";
    case "write":
      return "write";
    case "read":
      return "read";
    case "grep":
    case "find":
      return "search";
    case "ls":
      return "list";
    default:
      return "other";
  }
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The verb and typed summary of one member, MCP rows included. */
const memberSummary = (member: Pick<ToolGroupMember, "toolName" | "args" | "mcp">): { verb: string; summary: string } =>
  member.mcp ? mcpRowSummary(member.mcp, member.toolName, member.args) : summarizeTool(member.toolName, member.args);

const pathOf = (args: unknown): string | undefined => {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path ? path : undefined;
};

export function activeToolLabel(member: Pick<ToolGroupMember, "toolName" | "args" | "mcp">): string {
  if (member.mcp) return mcpActiveLabel(member.mcp, member.toolName, member.args);
  const summary = summarizeTool(member.toolName, member.args);
  const path = pathOf(member.args);
  const target = path && ["read", "write", "edit", "ls"].includes(summary.kind) ? shortPath(path, 2) : summary.summary;
  const action = (() => {
    switch (summary.kind) {
      case "read":
        return "Reading";
      case "write":
        return "Writing";
      case "edit":
        return "Editing";
      case "bash":
        return "Running";
      case "grep":
      case "find":
        return "Searching";
      case "ls":
        return "Listing";
      default:
        return `Using ${summary.verb}`;
    }
  })();
  return `${action}${target ? ` ${target}` : ""}`;
}

function summarizeFamily(
  family: Exclude<ToolGroupFamily, "mixed" | "reasoning">,
  members: readonly ToolGroupMember[],
  running: boolean,
): ToolGroupBreakdownItem {
  const count = members.length;
  const distinctFiles = new Set(members.map((member) => pathOf(member.args)).filter((path): path is string => path !== undefined)).size;
  let label: string;
  let detail: string | undefined;
  switch (family) {
    case "command":
      label = `${running ? "Running" : "Ran"} ${plural(count, "command", "commands")}`;
      break;
    case "edit": {
      const files = distinctFiles || count;
      label = `${running ? "Editing" : "Edited"} ${plural(files, "file", "files")}`;
      if (count > files) detail = plural(count, "edit", "edits");
      break;
    }
    case "write": {
      const files = distinctFiles || count;
      label = `${running ? "Writing" : "Wrote"} ${plural(files, "file", "files")}`;
      if (count > files) detail = plural(count, "write", "writes");
      break;
    }
    case "read": {
      const files = distinctFiles || count;
      label = `${running ? "Reading" : "Read"} ${plural(files, "file", "files")}`;
      if (count > files) detail = plural(count, "read", "reads");
      break;
    }
    case "search":
      label = `${running ? "Searching" : "Searched"} ${plural(count, "pattern", "patterns")}`;
      break;
    case "list":
      label = `${running ? "Listing" : "Listed"} ${plural(count, "directory", "directories")}`;
      break;
    default:
      label = `${running ? "Using" : "Used"} ${plural(count, "tool", "tools")}`;
  }
  const firstKind = toolKind(members[0]?.toolName ?? "");
  return { family, iconKind: family === "edit" ? "edit" : firstKind, label, detail };
}

/**
 * Name a run of tool calls. Edits and writes to the same file count once
 * ("Edited 1 file · 3 edits"): saying "3 files" for three edits to one file
 * would be a lie, and the file count is what a person wants to know.
 */
export function summarizeToolGroup(members: readonly ToolGroupMember[]): ToolGroupSummary {
  const count = members.length;
  const kinds = members.map((m) => toolKind(m.toolName));
  const families = new Set(kinds.map(familyOf));
  const combineFileChanges = families.has("edit") && families.has("write");
  if (combineFileChanges) families.delete("write");
  const family: ToolGroupFamily = families.size === 1 ? [...families][0]! : "mixed";
  const running = members.some((m) => m.running);
  const hasError = members.some((m) => m.isError && m.nonZeroExit !== true);
  const hasDecision = members.some((m) => m.awaiting);
  const live = members.find((m) => m.running || m.awaiting);
  const active = members.find((m) => m.running);
  const fileChanges = members.reduce(
    (total, member) => {
      const changes = member.isError || member.cancelled || member.running || member.awaiting ? undefined : member.diffStats;
      return {
        added: total.added + (changes?.added ?? 0),
        removed: total.removed + (changes?.removed ?? 0),
      };
    },
    { added: 0, removed: 0 },
  );
  const diffStats = fileChanges.added > 0 || fileChanges.removed > 0 ? fileChanges : undefined;

  const byFamily = new Map<Exclude<ToolGroupFamily, "mixed" | "reasoning">, ToolGroupMember[]>();
  for (const member of members) {
    const rawFamily = familyOf(toolKind(member.toolName));
    const memberFamily = combineFileChanges && rawFamily === "write" ? "edit" : rawFamily;
    const familyMembers = byFamily.get(memberFamily) ?? [];
    familyMembers.push(member);
    byFamily.set(memberFamily, familyMembers);
  }
  const breakdown = [...byFamily.entries()].map(([memberFamily, familyMembers]) =>
    summarizeFamily(memberFamily, familyMembers, familyMembers.some((member) => member.running)),
  );

  const ownSummary = family === "mixed" ? undefined : breakdown[0];
  let label = ownSummary?.label ?? `${running ? "Working through" : "Completed"} ${plural(count, "action", "actions")}`;
  let detail = ownSummary?.detail;

  // While live, the typed fragment is the call in flight: that is what you
  // would be reading in the expanded row.
  if (live) {
    const s = memberSummary(live);
    const text = s.summary || s.verb;
    if (text) detail = text;
  }

  const iconKind: ActivityIconKind = family === "mixed" ? "other" : (ownSummary?.iconKind ?? kinds[0] ?? "other");

  const lines = members.map((m) => {
    const s = memberSummary(m);
    // Quiet is not hidden: the line a screen reader and the tooltip read still
    // says a command came back non-zero, it just does not call it a failure.
    const status = m.nonZeroExit === true
      ? " — exited non-zero"
      : m.isError
        ? " — failed"
        : m.cancelled
          ? " — cancelled"
          : m.awaiting
            ? " — waiting for you"
            : m.running
              ? " — running"
              : "";
    return `${s.verb} ${s.summary || (pathOf(m.args) ? shortPath(pathOf(m.args)!) : "")}`.trim() + status;
  });

  return {
    family,
    iconKind,
    label,
    detail,
    count,
    hasError,
    hasDecision,
    running,
    activeLabel: active ? activeToolLabel(active) : undefined,
    breakdown: family === "mixed" ? breakdown : [],
    ...(diffStats ? { diffStats } : {}),
    lines,
  };
}

export interface ReasoningActivity {
  /** Number of reasoning rows rendered inside the aggregate. */
  readonly count: number;
  readonly running: boolean;
}

/**
 * Fold reasoning into the same compact activity summary as its tool work.
 * Count the actual child rows so expanding a summary never reveals a different total.
 */
export function summarizeActivityGroup(
  members: readonly ToolGroupMember[],
  reasoning: ReasoningActivity,
): ToolGroupSummary {
  if (reasoning.count === 0) return summarizeToolGroup(members);

  const toolSummary = members.length > 0 ? summarizeToolGroup(members) : undefined;
  const reasoningItem: ToolGroupBreakdownItem = {
    family: "reasoning",
    iconKind: "reasoning",
    label: reasoning.running ? "Thinking" : "Reasoned",
    detail: undefined,
  };
  const running = reasoning.running || toolSummary?.running === true;
  const toolBreakdown: readonly ToolGroupBreakdownItem[] = !toolSummary
    ? []
    : toolSummary.family === "mixed"
      ? toolSummary.breakdown
      : [
          {
            family: toolSummary.family,
            iconKind: toolSummary.iconKind,
            label: toolSummary.label,
            detail: toolSummary.detail,
          },
        ];
  const count = members.length + reasoning.count;

  if (!toolSummary) {
    return {
      family: "reasoning",
      iconKind: "reasoning",
      label: reasoning.running ? "Thinking" : "Reasoned",
      detail: undefined,
      count,
      hasError: false,
      hasDecision: false,
      running,
      activeLabel: reasoning.running ? "Thinking" : undefined,
      breakdown: [],
      lines: [reasoning.running ? "Reasoning — running" : "Reasoned"],
    };
  }

  return {
    family: "mixed",
    iconKind: "reasoning",
    label: `${running ? "Working through" : "Completed"} ${plural(count, "step", "steps")}`,
    detail: undefined,
    count,
    hasError: toolSummary.hasError,
    hasDecision: toolSummary.hasDecision,
    running,
    activeLabel: toolSummary.activeLabel ?? (reasoning.running ? "Thinking" : undefined),
    breakdown: [reasoningItem, ...toolBreakdown],
    ...(toolSummary.diffStats ? { diffStats: toolSummary.diffStats } : {}),
    lines: [reasoning.running ? "Reasoning — running" : "Reasoned", ...toolSummary.lines],
  };
}

/**
 * Open by default when something in the group wants eyes: an error to read or
 * a decision to make (DESIGN.md "Transcript"). Otherwise collapsed, because
 * a finished run of reads is noise until you ask — and so is a `grep` that
 * found nothing, which is why a non-zero shell exit is not an error here.
 */
export function toolGroupDefaultOpen(summary: Pick<ToolGroupSummary, "hasError" | "hasDecision">): boolean {
  return summary.hasError || summary.hasDecision;
}
