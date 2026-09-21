/**
 * The `document` adapter: a file the person attached, or a path they named.
 *
 * | | |
 * | --- | --- |
 * | Reach | local |
 * | Auth | local; the file must be inside the project or the session's attachments |
 * | Rate | local, unmetered by the adapter |
 * | Search result | the files whose name or text matches, with the line it matched on |
 * | Read result | bounded text, with the digest of the bytes on disk |
 *
 * Text, Markdown, JSON, CSV and source files are read as they are. **PDF is
 * not read** (D-351.f): no permissively-licensed, exact-pinned PDF parser is
 * a dependency of this workspace, and a research adapter does not acquire one
 * behind a person's back. The refusal names the gap and what to do instead,
 * and `RESEARCH_GAPS.pdf` is the same sentence wherever it is shown.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RESEARCH_GAPS, researchAdapter, type SourceRef } from "@lasercode/protocol";
import { digestOf } from "../cache.js";
import { ResearchRefused } from "../errors.js";
import { readableText } from "../readable-text.js";
import { serveSource } from "./serve.js";
import type { ResearchAdapter, ResearchAdapterContext, ResearchHit, ResearchReadInput, ResearchReadResult, ResearchSearchInput, ResearchSearchResult } from "./types.js";

const MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 2000;

/** Extensions this adapter reads as text. */
const TEXTUAL = new Set([
  ".txt", ".text", ".md", ".markdown", ".mdx", ".rst", ".adoc", ".org",
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".csv", ".tsv", ".html", ".htm", ".xml", ".svg",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".sql", ".graphql", ".proto", ".css", ".scss", ".less",
  ".log", ".diff", ".patch", ".lock", ".env.example",
]);

const BINARY_BUT_NAMED: Record<string, string> = {
  ".pdf": RESEARCH_GAPS.pdf,
  ".docx": "Word documents are not read in this version. Export the file as Markdown or plain text and attach that.",
  ".pptx": "Slide decks are not read in this version. Export the deck as text and attach that.",
  ".xlsx": "Spreadsheets are not read in this version. Export the sheet as CSV and attach that.",
};

/** The project, then this session's attachments. A path outside both is refused. */
function roots(context: ResearchAdapterContext): string[] {
  const list = [resolve(context.projectCwd)];
  if (context.attachmentsDir) list.push(resolve(context.attachmentsDir));
  return list;
}

/** Resolve a path inside the project or the attachments, or refuse. */
export function resolveDocumentPath(context: ResearchAdapterContext, path: string): { absolute: string; label: string } {
  const bases = roots(context);
  for (const base of bases) {
    const target = isAbsolute(path) ? resolve(path) : resolve(base, path);
    const rel = relative(base, target);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return { absolute: target, label: rel.split(sep).join("/") };
    }
  }
  throw new ResearchRefused(
    "outside_project",
    `"${path}" is not inside this project or the files attached to this conversation, and research reads no other part of this machine.`,
    "attach the file to the conversation, or name a path relative to the project",
  );
}

export function documentRef(label: string): SourceRef {
  return { kind: "document", id: `file:${label}`, title: label, fetchedVia: "document", trust: "secondary" };
}

function readable(path: string): { ok: true } | { ok: false; why: string } {
  const extension = extname(path).toLowerCase();
  const named = BINARY_BUT_NAMED[extension];
  if (named) return { ok: false, why: named };
  if (extension !== "" && !TEXTUAL.has(extension)) {
    return { ok: false, why: `${extension} files are not read as text. Attach a text or Markdown version of the same content.` };
  }
  return { ok: true };
}

export const documentResearchAdapter: ResearchAdapter = {
  id: "document",
  descriptor: researchAdapter("document"),

  /** Names the files that match, inside the project and the attachments. */
  async search(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchSearchResult> {
    context.ledger.chargeSearch("document", input.query);
    const words = input.query.toLowerCase().split(/[^a-z0-9_.-]+/i).filter((word) => word.length >= 2);
    const hits: ResearchHit[] = [];
    const notes: string[] = [];
    let skipped = 0;
    for (const base of roots(context)) {
      const queue = [base];
      let seen = 0;
      while (queue.length > 0 && seen < MAX_CANDIDATES) {
        const directory = queue.shift()!;
        let entries: string[];
        try {
          entries = readdirSync(directory);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name.startsWith(".") || name === "node_modules") continue;
          const path = join(directory, name);
          let stats;
          try {
            stats = statSync(path);
          } catch {
            continue;
          }
          if (stats.isDirectory()) {
            queue.push(path);
            continue;
          }
          seen += 1;
          const label = relative(base, path).split(sep).join("/");
          const check = readable(path);
          const nameMatch = words.length === 0 || words.some((word) => label.toLowerCase().includes(word));
          if (!check.ok) {
            if (nameMatch) skipped += 1;
            continue;
          }
          if (!TEXTUAL.has(extname(path).toLowerCase())) continue;
          let snippet = "";
          let matched = nameMatch;
          if (stats.size <= MAX_BYTES) {
            try {
              const text = readFileSync(path, "utf8");
              const lines = text.split("\n");
              const index = lines.findIndex((row) => words.some((word) => row.toLowerCase().includes(word)));
              if (index >= 0) {
                matched = true;
                snippet = lines.slice(index, index + 3).join("\n").slice(0, 400);
              }
            } catch {
              continue;
            }
          }
          if (!matched) continue;
          hits.push({ sourceRef: documentRef(label), title: basename(label), snippet });
          if (hits.length >= input.limit) break;
        }
      }
    }
    if (skipped > 0) notes.push(`${String(skipped)} matching file${skipped === 1 ? "" : "s"} could not be read as text. ${RESEARCH_GAPS.pdf}`);
    if (hits.length === 0) notes.push("No readable file matched that.");
    return { hits, ...(notes.length > 0 ? { notes } : {}) };
  },

  async read(input: ResearchReadInput, context: ResearchAdapterContext): Promise<ResearchReadResult> {
    const raw = input.ref.id.startsWith("file:") ? input.ref.id.slice("file:".length) : input.ref.id;
    const { absolute, label } = resolveDocumentPath(context, raw);
    const check = readable(absolute);
    if (!check.ok) {
      throw new ResearchRefused(
        "unsupported_document",
        check.why,
        "attach a text or Markdown version of the file, or quote the passage you need in the conversation",
      );
    }
    return serveSource({
      context,
      source: documentRef(label),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      load: async () => {
        let stats;
        try {
          stats = statSync(absolute);
        } catch {
          throw new ResearchRefused("no_such_file", `There is no file at ${label}.`, "search the document source for the file, or attach it to the conversation");
        }
        if (!stats.isFile()) throw new ResearchRefused("not_a_file", `${label} is a folder, not a file.`, "name a file inside it");
        const buffer = readFileSync(absolute).subarray(0, MAX_BYTES);
        if (buffer.includes(0)) {
          throw new ResearchRefused(
            "not_text",
            `${label} is not a text file, so there is nothing to quote from it. ${RESEARCH_GAPS.pdf}`,
            "attach a text or Markdown version of the file",
          );
        }
        const body = buffer.toString("utf8");
        const extracted = /\.(?:html?|xml|svg)$/i.test(absolute) ? readableText(body, { maxBytes: MAX_BYTES }) : { text: body, title: undefined, publishedAt: undefined };
        return {
          text: extracted.text,
          digest: digestOf(buffer),
          bytes: buffer.byteLength,
          canonical: `file:${label}`,
          title: extracted.title ?? basename(label),
          licence: "unknown" as const,
          notices: stats.size > MAX_BYTES ? [`Only the first ${String(Math.round(MAX_BYTES / 1024))} KB of this file were read.`] : [],
        };
      },
    });
  },
};
