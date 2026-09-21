/**
 * The `project` adapter: this project's own code and history.
 *
 * | | |
 * | --- | --- |
 * | Reach | local, fenced by the project this session is open on |
 * | Auth | project trust |
 * | Rate | local, unmetered by the adapter; the run's budget still applies |
 * | Search result | file matches and commits, with the line the term was found on |
 * | Read result | a bounded window of the file, or the commit as git reports it |
 *
 * Findings from here are the `observed` ones: the agent really read this file
 * or ran this command in this project (`docs/research-phase.md`, "Rules").
 * Existing Research, Specs and Designs are **not** read here — the leap's own
 * `inspect_project_work` does that, and duplicating it would give two answers
 * to the same question.
 *
 * Nothing is executed: the walk opens files, and git is asked for history
 * through git-actions' own runner (argv, scrubbed environment, no shell).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { researchAdapter, type SourceRef } from "@lasercode/protocol";
import { digestOf } from "../cache.js";
import { ResearchRefused } from "../errors.js";
import { serveSource } from "./serve.js";
import type { ResearchAdapter, ResearchAdapterContext, ResearchHit, ResearchReadInput, ResearchReadResult, ResearchSearchInput, ResearchSearchResult } from "./types.js";

/** Directories a project search never walks into. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".worktrees",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pnpm-store",
]);

/** Extensions a text search does not open. */
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|mov|mp4|avi|mkv|wav|ogg|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|class|jar|wasm|node|db|sqlite3?|lock)$/i;

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

export interface ProjectSearchLimits {
  maxFiles?: number;
  maxFileBytes?: number;
}

function insideProject(projectCwd: string, path: string): string {
  const root = resolve(projectCwd);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ResearchRefused(
      "outside_project",
      `"${path}" is not inside this project, and this source only ever reads the project this session is open on.`,
      "name a path relative to the project, or read a file you attached with the document adapter",
    );
  }
  return target;
}

function* walk(root: string, limits: ProjectSearchLimits): Generator<string> {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  let seen = 0;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (seen >= maxFiles) return;
      const path = join(directory, name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) queue.push(path);
        continue;
      }
      if (!stats.isFile()) continue;
      if (BINARY.test(name)) continue;
      if (stats.size > (limits.maxFileBytes ?? MAX_FILE_BYTES)) continue;
      seen += 1;
      yield path;
    }
  }
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_.@/-]+/i).filter((word) => word.length >= 2))].slice(0, 8);
}

export function projectFileRef(path: string): SourceRef {
  return { kind: "project", id: `path:${path}`, title: path, fetchedVia: "project", trust: "primary" };
}

export function projectCommitRef(commit: string, subject: string): SourceRef {
  return { kind: "project", id: `commit:${commit}`, title: subject.slice(0, 500), fetchedVia: "project", trust: "primary" };
}

async function historyHits(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchHit[]> {
  const run = context.run;
  if (!run) return [];
  const args = ["log", "-n", String(Math.min(input.limit, 10)), "--no-merges", "--date=short", "--pretty=format:%H\u0000%ad\u0000%s\u0000%b\u001e", "--regexp-ignore-case", `--grep=${input.query}`];
  if (input.after) args.push(`--since=${input.after}`);
  if (input.before) args.push(`--until=${input.before}`);
  let result;
  try {
    result = await run("git", args, { cwd: context.projectCwd, timeoutMs: 15_000 });
  } catch {
    return [];
  }
  if (!result.spawned || result.code !== 0) return [];
  const hits: ResearchHit[] = [];
  for (const record of result.stdout.split("\u001e")) {
    const [commit, date, subject, body] = record.trim().split("\u0000");
    if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) continue;
    hits.push({
      sourceRef: projectCommitRef(commit, subject ?? commit.slice(0, 12)),
      title: subject ?? commit.slice(0, 12),
      snippet: (body ?? "").trim().slice(0, 400) || (subject ?? ""),
      ...(date !== undefined && date !== "" ? { date } : {}),
    });
  }
  return hits;
}

export const projectResearchAdapter: ResearchAdapter = {
  id: "project",
  descriptor: researchAdapter("project"),

  async search(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchSearchResult> {
    context.ledger.chargeSearch("project", input.query, input.after ?? input.before);
    const words = terms(input.query);
    if (words.length === 0) {
      return { hits: [], notes: ["That query had nothing to match on."] };
    }
    const root = resolve(context.projectCwd);
    const scored: Array<{ hit: ResearchHit; score: number }> = [];
    for (const path of walk(root, {})) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lower = text.toLowerCase();
      let score = 0;
      for (const word of words) {
        const occurrences = lower.split(word).length - 1;
        if (occurrences > 0) score += Math.min(occurrences, 10);
      }
      const name = relative(root, path);
      for (const word of words) if (name.toLowerCase().includes(word)) score += 5;
      if (score === 0) continue;
      const lines = text.split("\n");
      const lineIndex = lines.findIndex((line) => words.some((word) => line.toLowerCase().includes(word)));
      const snippet = lines
        .slice(Math.max(0, lineIndex - 1), Math.max(0, lineIndex) + 3)
        .join("\n")
        .slice(0, 400);
      scored.push({
        score,
        hit: { sourceRef: projectFileRef(name.split(sep).join("/")), title: name.split(sep).join("/"), snippet, score },
      });
    }
    scored.sort((left, right) => right.score - left.score);
    const files = scored.slice(0, input.limit).map((row) => row.hit);
    const history = await historyHits(input, context);
    const hits = [...files, ...history].slice(0, input.limit);
    const omitted = Math.max(0, scored.length + history.length - hits.length);
    return {
      hits,
      ...(omitted > 0 ? { omitted } : {}),
      ...(hits.length === 0 ? { notes: ["Nothing in this project's files or history matched those terms."] } : {}),
    };
  },

  async read(input: ResearchReadInput, context: ResearchAdapterContext): Promise<ResearchReadResult> {
    const id = input.ref.id;
    if (id.startsWith("commit:")) {
      const commit = id.slice("commit:".length);
      if (!/^[0-9a-f]{7,64}$/.test(commit)) {
        throw new ResearchRefused("bad_commit", `"${commit}" is not a commit id.`, "search this project again and read one of the commits it returns");
      }
      return serveSource({
        context,
        source: projectCommitRef(commit, input.ref.title !== "" ? input.ref.title : commit.slice(0, 12)),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        load: async () => {
          const run = context.run;
          if (!run) throw new ResearchRefused("no_history", "This project's history cannot be read here.", "read the files instead");
          const result = await run("git", ["show", "--stat", "--no-color", "--date=iso", commit], { cwd: context.projectCwd, timeoutMs: 15_000 });
          if (!result.spawned || result.code !== 0) {
            throw new ResearchRefused(
              "no_such_commit",
              `This project's history has no commit ${commit.slice(0, 12)}.`,
              "search this project again and read a commit it returns",
            );
          }
          const text = result.stdout.slice(0, MAX_READ_BYTES);
          return { text, digest: digestOf(text), bytes: Buffer.byteLength(text, "utf8"), canonical: id, title: input.ref.title };
        },
      });
    }
    const relativePath = id.startsWith("path:") ? id.slice("path:".length) : id;
    const absolute = insideProject(context.projectCwd, relativePath);
    return serveSource({
      context,
      source: projectFileRef(relativePath),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      load: async () => {
        let stats;
        try {
          stats = statSync(absolute);
        } catch {
          throw new ResearchRefused(
            "no_such_file",
            `This project has no file at ${relativePath}.`,
            "search this project again and read one of the paths it returns",
          );
        }
        if (!stats.isFile()) {
          throw new ResearchRefused("not_a_file", `${relativePath} is a folder, not a file.`, "name a file inside it");
        }
        const buffer = readFileSync(absolute).subarray(0, MAX_READ_BYTES);
        if (buffer.includes(0)) {
          throw new ResearchRefused(
            "not_text",
            `${relativePath} is a binary file, so there is no text to quote from it.`,
            "read a text file, or describe what you need from this one in the conversation",
          );
        }
        const text = buffer.toString("utf8");
        return {
          text,
          digest: digestOf(text),
          bytes: buffer.byteLength,
          canonical: `path:${relativePath}`,
          title: relativePath,
          licence: "not_applicable" as const,
          notices: stats.size > MAX_READ_BYTES ? [`Only the first ${String(Math.round(MAX_READ_BYTES / 1024))} KB of this file were read.`] : [],
        };
      },
    });
  },
};
