/**
 * Reading other people's Markdown (M21-T21).
 *
 * Every import adapter is a text parser and nothing else: it opens files,
 * splits headings, reads bullets and tables, and proposes closed bodies. It
 * runs no tool, evaluates no configuration, follows no link and opens no
 * network connection — an import is a *read of files a person already has*,
 * and the external tool never becomes a writer of Laser's own work.
 *
 * What cannot be parsed is reported as a note or a skipped file with its
 * reason. Nothing is invented to fill a shape: a Spec without acceptance
 * criteria imports with none, which is the truth about the document.
 */
import { parse as parseYaml } from "yaml";
import { SOURCE_LICENCES, type SourceLicence } from "@lasercode/protocol";

/** One `## Heading` and everything under it, until the next heading of that depth. */
export interface Section {
  depth: number;
  heading: string;
  /** The body of the section, without its own heading. */
  text: string;
}

export interface ParsedMarkdown {
  /** The YAML front matter, when the file opens with one. Never executed. */
  front: Record<string, unknown>;
  /** The `# Title`, when the file has one. */
  title?: string;
  /** Everything after the front matter, as written. */
  content: string;
  /** The text between the title and the first `##`. */
  lede: string;
  sections: Section[];
}

/**
 * Split a Markdown file into front matter, title, lede and sections.
 *
 * Fenced code blocks are tracked, so a `## heading` inside a fence is content
 * rather than a section — an import that split on it would cut a person's own
 * example in half.
 */
export function parseMarkdown(text: string): ParsedMarkdown {
  const { front, body } = splitFrontMatter(text);
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let title: string | undefined;
  const lede: string[] = [];
  let current: { depth: number; heading: string; lines: string[] } | undefined;
  let fenced = false;

  const flush = (): void => {
    if (!current) return;
    sections.push({ depth: current.depth, heading: current.heading, text: current.lines.join("\n").trim() });
    current = undefined;
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (current) current.lines.push(line);
      else if (title !== undefined) lede.push(line);
      continue;
    }
    const depth = heading[1]!.length;
    const label = heading[2]!.trim();
    if (depth === 1 && title === undefined && !current) {
      title = label;
      continue;
    }
    flush();
    current = { depth, heading: label, lines: [] };
  }
  flush();

  return {
    front,
    ...(title !== undefined ? { title } : {}),
    content: body.trim(),
    lede: lede.join("\n").trim(),
    sections,
  };
}

/** The front matter of a file, or an empty record. A broken one is not a throw. */
function splitFrontMatter(text: string): { front: Record<string, unknown>; body: string } {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!/^---\r?\n/.test(withoutBom)) return { front: {}, body: withoutBom };
  const end = withoutBom.indexOf("\n---", 4);
  if (end < 0) return { front: {}, body: withoutBom };
  const header = withoutBom.slice(4, end);
  const rest = withoutBom.slice(withoutBom.indexOf("\n", end + 1) + 1);
  try {
    const parsed: unknown = parseYaml(header);
    return { front: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}, body: rest };
  } catch {
    return { front: {}, body: rest };
  }
}

/** The first section whose heading matches, at any depth. */
export function section(parsed: ParsedMarkdown, pattern: RegExp): Section | undefined {
  return parsed.sections.find((candidate) => pattern.test(candidate.heading));
}

/** Every section whose heading matches, in file order. */
export function sections(parsed: ParsedMarkdown, pattern: RegExp): Section[] {
  return parsed.sections.filter((candidate) => pattern.test(candidate.heading));
}

/** The text of the first matching section, or nothing. */
export function sectionText(parsed: ParsedMarkdown, pattern: RegExp): string | undefined {
  const found = section(parsed, pattern);
  const text = found ? stripSubHeadings(found.text) : "";
  return text === "" ? undefined : text;
}

/** A section's own prose, without the sub-headings that belong to its children. */
function stripSubHeadings(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join("\n")
    .trim();
}

/** Top-level bullets of a block: `- x`, `* x`, `1. x`, and task boxes. */
export function bullets(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s{0,3}(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!match) continue;
    const item = match[1]!.trim();
    if (item !== "") out.push(item);
  }
  return out;
}

/** A checklist line: `- [ ] T001 [P] Do the thing`. */
export interface ChecklistItem {
  done: boolean;
  /** The id the list gives it (`T001`, `1.2`), when it has one. */
  id?: string;
  text: string;
}

export function checklist(text: string | undefined): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const item of bullets(text)) {
    const box = /^\[([ xX])\]\s*(.*)$/.exec(item);
    if (!box) continue;
    let rest = box[2]!.trim();
    const id = /^((?:T\d{1,4})|(?:\d+(?:\.\d+)*))\s+(.*)$/.exec(rest);
    const found = id ? id[1] : undefined;
    if (id) rest = id[2]!.trim();
    // `[P]` and `[US1]` are the list's own markers, not part of the sentence.
    rest = rest.replace(/^(\[[A-Za-z0-9]{1,8}\]\s*)+/, "").trim();
    if (rest === "") continue;
    out.push({ done: box[1]!.toLowerCase() === "x", ...(found !== undefined ? { id: found } : {}), text: rest });
  }
  return out;
}

/** A GitHub-flavoured table: the header row's cells, then each row's cells. */
export function table(text: string | undefined): { headers: string[]; rows: string[][] } | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  if (lines.length < 2) return undefined;
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replace(/\\\|/g, "|").trim());
  const headers = cells(lines[0]!);
  if (!/^[\s|:-]+$/.test(lines[1]!)) return undefined;
  const rows = lines.slice(2).map(cells).filter((row) => row.some((cell) => cell !== ""));
  return { headers, rows };
}

/** The first paragraph of a block, for a summary line. */
export function firstParagraph(text: string | undefined): string {
  if (!text) return "";
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const cleaned = block
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:[-*+]|\d+\.)\s+/.test(line) && !/^#{1,6}\s/.test(line))
      .join(" ")
      .trim();
    if (cleaned !== "") return cleaned;
  }
  return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
}

/** One line, bounded, for a title or a summary. */
export function oneLine(value: string, max = 200): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Strip the Markdown a heading or a bullet carries, for a plain title. */
export function plainText(value: string): string {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

// ---------------------------------------------------------------------------
// Licence
// ---------------------------------------------------------------------------

const LICENCE_PATTERNS: ReadonlyArray<{ match: RegExp; licence: SourceLicence }> = [
  { match: /\b(agpl|gpl|lgpl|mpl|epl|cddl|cc-?by-?sa)\b/i, licence: "copyleft" },
  { match: /\b(mit|apache|bsd|isc|unlicense|cc0|zlib|bsl-1)\b/i, licence: "permissive" },
  { match: /\b(proprietary|all rights reserved|commercial)\b/i, licence: "proprietary" },
];

/**
 * The licence a source declares, in the vocabulary the domain already has.
 *
 * Never guessed beyond what the text says: a file that declares nothing gets
 * `unknown`, which travels with the import as "no licence was declared" rather
 * than as an assumption a person did not make (leap, "every imported
 * component, asset or code candidate retains licence and source provenance").
 */
export function readLicence(declared: string | undefined): { licence: SourceLicence; licenceName?: string } | undefined {
  const text = (declared ?? "").trim();
  if (text === "") return undefined;
  const name = oneLine(text, 120);
  for (const pattern of LICENCE_PATTERNS) {
    if (pattern.match.test(text)) return { licence: pattern.licence, licenceName: name };
  }
  const exact = SOURCE_LICENCES.find((value) => value === text.toLowerCase());
  return exact ? { licence: exact, licenceName: name } : { licence: "unknown", licenceName: name };
}

/** The licence a front matter declares, under any of the names people use. */
export function licenceFromFront(front: Record<string, unknown>): { licence: SourceLicence; licenceName?: string } | undefined {
  for (const name of ["licence", "license", "spdx", "spdx-license-identifier"]) {
    const value = front[name];
    if (typeof value === "string") return readLicence(value);
  }
  return undefined;
}
