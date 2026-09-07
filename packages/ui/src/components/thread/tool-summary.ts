/**
 * Pure helpers for tool rows: per-tool verb/summary for Pi's built-ins, result
 * text extraction, and the bash exit-code parse. No React, no DOM.
 *
 * Pi 0.85 built-in arg names (verified in
 * `@earendil-works/pi-coding-agent/dist/core/tools/*.js`):
 *   read  { path, offset?, limit? }
 *   write { path, content }
 *   edit  { path, edits: [{ oldText, newText }] }
 *   bash  { command, timeout? }
 *   grep  { pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }
 *   find  { pattern, path?, limit? }
 *   ls    { path?, limit? }
 */

import { toolOutputText } from "@lasercode/protocol";

export type ToolKind = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls" | "other";

export interface ToolSummary {
  readonly kind: ToolKind;
  /** Host Grotesk 500 verb, e.g. "Read". */
  readonly verb: string;
  /** Martian Mono summary: a path, a command, a pattern. Empty when unknown. */
  readonly summary: string;
  /** Second typed fragment shown after the summary in tertiary ink (e.g. the grep path). */
  readonly detail?: string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Collapse whitespace and cap the length for a one-line row. */
export function oneLine(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `/a/b/c/d.ts` → `c/d.ts`; keeps short paths untouched. */
export function shortPath(path: string, depth = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= depth) return path;
  return parts.slice(-depth).join("/");
}

export function toolKind(name: string): ToolKind {
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "bash":
    case "grep":
    case "find":
    case "ls":
      return name;
    default:
      return "other";
  }
}

export function summarizeTool(name: string, args: unknown): ToolSummary {
  const a = isRecord(args) ? args : {};
  const kind = toolKind(name);
  switch (kind) {
    case "read": {
      const offset = num(a["offset"]);
      const limit = num(a["limit"]);
      const range =
        offset !== undefined || limit !== undefined
          ? `${offset ?? 1}${limit !== undefined ? `–${(offset ?? 1) + limit - 1}` : "…"}`
          : undefined;
      return { kind, verb: "Read", summary: shortPath(str(a["path"])), ...(range ? { detail: `L${range}` } : {}) };
    }
    case "write":
      return { kind, verb: "Write", summary: shortPath(str(a["path"])) };
    case "edit": {
      const edits = Array.isArray(a["edits"]) ? a["edits"].length : 0;
      return {
        kind,
        verb: "Edit",
        summary: shortPath(str(a["path"])),
        ...(edits > 1 ? { detail: `${edits} edits` } : {}),
      };
    }
    case "bash":
      return { kind, verb: "Run", summary: oneLine(str(a["command"])) };
    case "grep": {
      const path = str(a["path"]);
      return { kind, verb: "Grep", summary: oneLine(str(a["pattern"]), 80), ...(path ? { detail: shortPath(path) } : {}) };
    }
    case "find": {
      const path = str(a["path"]);
      return { kind, verb: "Find", summary: oneLine(str(a["pattern"]), 80), ...(path ? { detail: shortPath(path) } : {}) };
    }
    case "ls":
      return { kind, verb: "List", summary: shortPath(str(a["path"]) || "."), };
    default: {
      const key = ["command", "path", "file_path", "pattern", "query", "url", "name"].find((k) => str(a[k]));
      return { kind, verb: name, summary: key ? oneLine(str(a[key])) : "" };
    }
  }
}

/**
 * The text of a tool result. Live results are Pi `AgentToolResult`s
 * (`{ content: [{type:"text",text}], details }`); hydrated ones are already
 * strings; anything else is pretty-printed JSON.
 */
export function resultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  return toolOutputText(result) ?? pretty(result);
}

/** `details` of a live `AgentToolResult`, if any. */
export function resultDetails(result: unknown): Record<string, unknown> | undefined {
  if (isRecord(result) && isRecord(result["details"])) return result["details"];
  return undefined;
}

export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Elision
//
// A `bash` that cats a large file or a grep over a monorepo returns megabytes.
// `max-h-80 overflow-auto` bounds the painted box but not the DOM: the browser
// still lays out every line. Cap what reaches the DOM instead, and let the row
// offer the full text on demand.
// ---------------------------------------------------------------------------

export interface ElidedText {
  /** What to render. */
  readonly text: string;
  /** True when `text` is shorter than the input. */
  readonly truncated: boolean;
  /** What was dropped, for the "show all" affordance. Empty when nothing was. */
  readonly note: string;
}

export const ELISION_HEAD_LINES = 2000;
export const ELISION_TAIL_LINES = 500;
export const ELISION_MAX_CHARS = 200_000;

const count = (n: number, unit: string): string => `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`;

/** Head + tail of `text`, with a marker in place of the middle. */
export function elideText(
  text: string,
  options: { headLines?: number; tailLines?: number; maxChars?: number } = {},
): ElidedText {
  const headLines = options.headLines ?? ELISION_HEAD_LINES;
  const tailLines = options.tailLines ?? ELISION_TAIL_LINES;
  const maxChars = options.maxChars ?? ELISION_MAX_CHARS;

  let head = text;
  let tail = "";
  let charsElided = 0;
  // Slice by characters first: splitting megabytes into lines is exactly the
  // cost we are trying to avoid.
  if (text.length > maxChars) {
    const headChars = Math.floor(maxChars * 0.8);
    head = text.slice(0, headChars);
    tail = text.slice(text.length - (maxChars - headChars));
    charsElided = text.length - head.length - tail.length;
  }

  let linesElided = 0;
  if (tail === "") {
    const lines = head.split("\n");
    if (lines.length > headLines + tailLines) {
      linesElided = lines.length - headLines - tailLines;
      head = lines.slice(0, headLines).join("\n");
      tail = lines.slice(lines.length - tailLines).join("\n");
    }
  } else {
    const headOnes = head.split("\n");
    if (headOnes.length > headLines) {
      linesElided += headOnes.length - headLines;
      head = headOnes.slice(0, headLines).join("\n");
    }
    const tailOnes = tail.split("\n");
    if (tailOnes.length > tailLines) {
      linesElided += tailOnes.length - tailLines;
      tail = tailOnes.slice(tailOnes.length - tailLines).join("\n");
    }
  }

  if (charsElided === 0 && linesElided === 0) return { text, truncated: false, note: "" };
  const parts: string[] = [];
  if (linesElided > 0) parts.push(count(linesElided, "line"));
  if (charsElided > 0) parts.push(count(charsElided, "character"));
  const note = parts.join(" and ");
  return { text: `${head}\n\n…  ${note} elided  …\n\n${tail}`, truncated: true, note };
}

const EXIT_RE = /\n?\n?Command exited with code (\d+)\s*$/;

/**
 * Pi's bash tool appends "Command exited with code N" to the error text.
 * Split that status line off so the terminal header can own it.
 */
export function parseBashOutput(text: string, isError: boolean): { output: string; exitCode: number | undefined } {
  const match = EXIT_RE.exec(text);
  if (match) {
    const code = Number.parseInt(match[1] ?? "", 10);
    return { output: text.slice(0, match.index).replace(/\s+$/, ""), exitCode: Number.isFinite(code) ? code : undefined };
  }
  return { output: text, exitCode: isError ? undefined : 0 };
}

/** Which expanded body a tool row shows. */
export type ToolBody = "terminal" | "diff" | "text";

export function toolBody(kind: ToolKind): ToolBody {
  if (kind === "bash") return "terminal";
  if (kind === "edit" || kind === "write") return "diff";
  return "text";
}
