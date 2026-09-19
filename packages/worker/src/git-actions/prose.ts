/**
 * Commit messages and pull-request prose from the session's current model.
 *
 * The Namer is a small model for session titles and has not seen the code.
 * This talks to the same runtime the session is using, with recent commit
 * subjects and the project's instructions in the prompt. The result is text
 * to edit; nothing here commits.
 */
import type { GitProseKind, GitProseResult } from "@lasercode/protocol";
import { GitActionError } from "./paths.js";
import type { ProcessRunner } from "./runner.js";

export interface GitProseModel {
  provider: string;
  id: string;
}

export interface GitProseContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

export interface GitProseCompletion {
  content: ReadonlyArray<{ type: string; text?: string }>;
}

export interface GitProseRuntime {
  getModel(provider: string, id: string): GitProseModel | undefined;
  completeSimple(
    model: GitProseModel,
    context: GitProseContext,
    options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<GitProseCompletion>;
}

export interface GenerateProseInput {
  run: ProcessRunner;
  repo: string;
  kind: GitProseKind;
  files: readonly string[];
  summary?: string;
  model: { provider: string; id: string } | null;
  excerpt: string;
  instructions: string;
  runtime: GitProseRuntime;
}

const MAX_TOKENS: Record<GitProseKind, number> = {
  commit: 400,
  pr_title: 80,
  pr_description: 800,
};

const TIMEOUT_MS = 20_000;

export async function generateProse(input: GenerateProseInput): Promise<GitProseResult> {
  if (!input.model) {
    throw new GitActionError("This conversation has no model. Pick a model, then try again.");
  }
  const resolved = input.runtime.getModel(input.model.provider, input.model.id);
  if (!resolved) {
    throw new GitActionError("The session's model is not available. Pick a model, then try again.");
  }
  const subjects = await recentSubjects(input.run, input.repo);
  const context = prosePrompt(input.kind, input.files, input.summary, subjects, input.instructions, input.excerpt);
  const completion = await input.runtime.completeSimple(resolved, context, {
    maxTokens: MAX_TOKENS[input.kind] ?? 400,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = cleanProse(completion.content.map((part) => part.text ?? "").join(""), input.kind);
  if (!text) throw new GitActionError("The model did not return any text. Write it yourself, or try again.");
  return { kind: input.kind, text, model: { provider: resolved.provider, id: resolved.id } };
}

export async function recentSubjects(run: ProcessRunner, repo: string): Promise<string[]> {
  const result = await run("git", ["log", "-20", "--format=%s"], { cwd: repo, timeoutMs: 8_000 });
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20);
}

export function prosePrompt(
  kind: GitProseKind,
  files: readonly string[],
  summary: string | undefined,
  subjects: readonly string[],
  instructions: string,
  excerpt: string,
): GitProseContext {
  const contract =
    kind === "commit"
      ? "Reply with only a commit message. First line at most 72 characters, in the project's existing style. No quotes, no explanation."
      : kind === "pr_title"
        ? "Reply with only a pull-request title, at most 72 characters, in the project's existing style. No quotes, no explanation."
        : "Reply with only a pull-request description in Markdown. Cover what changed and why. No surrounding quotes.";
  const parts = [
    instructions.trim() ? `Project instructions:\n${instructions.trim().slice(0, 4000)}` : "",
    subjects.length > 0 ? `Recent commit subjects:\n${subjects.map((s) => `- ${s}`).join("\n")}` : "",
    `Files:\n${files.map((f) => `- ${f}`).join("\n")}`,
    summary?.trim() ? `Summary:\n${summary.trim().slice(0, 4000)}` : "",
    excerpt.trim() ? `Conversation that produced this change:\n${excerpt.trim().slice(0, 6000)}` : "",
  ].filter(Boolean);
  return {
    systemPrompt: contract,
    messages: [{ role: "user", content: `${parts.join("\n\n")}\n\n${kind === "commit" ? "Commit message:" : kind === "pr_title" ? "Title:" : "Description:"}`, timestamp: Date.now() }],
  };
}

export function cleanProse(raw: string, kind: GitProseKind): string {
  let text = raw.trim();
  text = text.replace(/^```(?:\w+)?\n?|\n?```$/g, "").trim();
  text = text.replace(/^(?:commit message|title|description)\s*:\s*/i, "");
  if (kind === "pr_title" || kind === "commit") {
    const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
    return first.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  }
  return text;
}

export function excerptFromEntries(entries: unknown[]): string {
  const chunks: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const text = collectText(entry);
    if (!text) continue;
    if (used + text.length > 6000) {
      chunks.push(text.slice(0, 6000 - used));
      break;
    }
    chunks.push(text);
    used += text.length;
  }
  return chunks.join("\n").trim();
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value.trim() ? value : "";
  if (value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n");
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && (record.type === "text" || record.type === undefined)) return record.text;
  if (record.role === "user" || record.role === "assistant" || record.role === "message") {
    return collectText(record.content ?? record.message ?? record.text);
  }
  if (record.type === "message" || record.type === "user" || record.type === "assistant") {
    return collectText(record.message ?? record.content ?? record.text);
  }
  return "";
}
