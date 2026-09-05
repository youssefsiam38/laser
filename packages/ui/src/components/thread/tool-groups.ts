/**
 * Pure helpers for the collapsed tool-group row (D-20 §4): what a run of
 * consecutive tool calls is called — "Ran 2 commands", "Edited 3 files",
 * "Read 5 files", "Searched 2 patterns" — and whether it should open by
 * default. No React, no DOM. Tested in test/thread/tool-groups.test.ts.
 */
import { shortPath, summarizeTool, toolKind, type ToolKind } from "./tool-summary.js";

/** What the group needs to know about one call; a projection of the tool part. */
export interface ToolGroupMember {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly isError: boolean;
  readonly running: boolean;
  /** An approval or interrupt is waiting on a person. */
  readonly awaiting: boolean;
  readonly cancelled: boolean;
}

/** The family a group is named after. `mixed` = more than one family. */
export type ToolGroupFamily = "command" | "edit" | "write" | "read" | "search" | "list" | "other" | "mixed";

export interface ToolGroupSummary {
  readonly family: ToolGroupFamily;
  /** Icon to draw when nothing is running; the family's own, `Wrench` for mixed. */
  readonly iconKind: ToolKind;
  /** Host Grotesk 500 label, e.g. "Ran 2 commands" or "Running 2 commands" while live. */
  readonly label: string;
  /** Typed fragment after the label: the live call while running, or "· 3 edits" when calls outnumber files. */
  readonly detail: string | undefined;
  readonly count: number;
  readonly hasError: boolean;
  readonly hasDecision: boolean;
  readonly running: boolean;
  /** Full list for the accessible name and the tooltip: one line per call. */
  readonly lines: readonly string[];
}

/** The family a tool name belongs to. */
export const toolFamily = (toolName: string): Exclude<ToolGroupFamily, "mixed"> => familyOf(toolKind(toolName));

/** Grouping key for the transcript: edits and writes share one ("files changed"). */
export const toolGroupKey = (toolName: string): string => {
  const family = toolFamily(toolName);
  return family === "write" ? "edit" : family;
};

const familyOf = (kind: ToolKind): Exclude<ToolGroupFamily, "mixed"> => {
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

const pathOf = (args: unknown): string | undefined => {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path ? path : undefined;
};

/**
 * Name a run of tool calls. Edits and writes to the same file count once
 * ("Edited 1 file · 3 edits"): saying "3 files" for three edits to one file
 * would be a lie, and the file count is what a person wants to know.
 */
export function summarizeToolGroup(members: readonly ToolGroupMember[]): ToolGroupSummary {
  const count = members.length;
  const kinds = members.map((m) => toolKind(m.toolName));
  const families = new Set(kinds.map(familyOf));
  // Edit + write is one story: files changed.
  if (families.has("edit") && families.has("write")) {
    families.delete("write");
  }
  const family: ToolGroupFamily = families.size === 1 ? [...families][0]! : "mixed";
  const running = members.some((m) => m.running);
  const hasError = members.some((m) => m.isError);
  const hasDecision = members.some((m) => m.awaiting);
  const live = members.find((m) => m.running || m.awaiting);

  const distinctFiles = new Set(members.map((m) => pathOf(m.args)).filter((p): p is string => p !== undefined)).size;
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

  // While live, the typed fragment is the call in flight: that is what you
  // would be reading in the expanded row.
  if (live) {
    const s = summarizeTool(live.toolName, live.args);
    const text = s.summary || s.verb;
    if (text) detail = text;
  }

  const iconKind: ToolKind = family === "mixed" ? "other" : (kinds[0] ?? "other");

  const lines = members.map((m) => {
    const s = summarizeTool(m.toolName, m.args);
    const status = m.isError ? " — failed" : m.cancelled ? " — cancelled" : m.awaiting ? " — waiting for you" : m.running ? " — running" : "";
    return `${s.verb} ${s.summary || (pathOf(m.args) ? shortPath(pathOf(m.args)!) : "")}`.trim() + status;
  });

  return { family, iconKind, label, detail, count, hasError, hasDecision, running, lines };
}

/**
 * Open by default when something in the group wants eyes: an error to read or
 * a decision to make (DESIGN.md "Transcript"). Otherwise collapsed, because
 * a finished run of reads is noise until you ask.
 */
export function toolGroupDefaultOpen(summary: Pick<ToolGroupSummary, "hasError" | "hasDecision">): boolean {
  return summary.hasError || summary.hasDecision;
}
