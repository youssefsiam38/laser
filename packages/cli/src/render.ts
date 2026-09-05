/**
 * `laser tail` — session updates as readable terminal lines.
 *
 * Two rules shape this file:
 *
 * 1. Assistant text is written as it streams, character for character, because
 *    a tail that buffers until `message_end` is a log viewer, not a tail.
 * 2. Everything that came from the agent, a tool, or an extension goes through
 *    `sanitize()` first. A tool result is untrusted bytes; letting it carry an
 *    escape sequence into a terminal is the CLI's version of rendering agent
 *    output as HTML (AGENTS.md invariant 9).
 */
import type { SessionUpdate, UiDialogRequest, UiFireAndForget } from "@lasercode/protocol";
import { sanitize, type Painter } from "./output.js";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** First line of a possibly long, possibly hostile string, clipped to `max`. */
export function firstLine(text: string, max = 100): string {
  const clean = sanitize(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A one-line gist of a tool's arguments. Prefers the fields that identify what
 * the tool is acting on, then falls back to the first short string, then to
 * compact JSON. Never more than one line.
 */
export function summarizeArgs(args: unknown, max = 100): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return firstLine(args, max);
  if (typeof args !== "object") return firstLine(String(args), max);

  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "filePath", "pattern", "query", "url", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return firstLine(value, max);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim() !== "") return firstLine(value, max);
  }
  try {
    return firstLine(JSON.stringify(record), max);
  } catch {
    return "";
  }
}

/** The human-readable part of a tool result, whatever shape the tool used. */
export function summarizeResult(result: unknown, max = 100): string {
  if (typeof result === "string") return firstLine(result, max);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["error", "message", "output", "stdout", "content", "text"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return firstLine(value, max);
    }
  }
  return "";
}

export interface TailRendererOptions {
  paint: Painter;
  write: (text: string) => void;
  /** Include thinking deltas. Off by default: they are long and rarely wanted. */
  thinking?: boolean;
}

/**
 * Stateful because a tail is stateful: it has to know whether the cursor sits
 * mid-line (so a tool row does not land inside a sentence) and when each tool
 * call started (so it can report a duration).
 */
export class TailRenderer {
  private readonly paint: Painter;
  private readonly write: (text: string) => void;
  private readonly showThinking: boolean;
  private readonly toolStarts = new Map<string, { name: string; at: number }>();
  private atLineStart = true;
  private thinkingOpen = false;

  constructor(options: TailRendererOptions) {
    this.paint = options.paint;
    this.write = options.write;
    this.showThinking = options.thinking ?? false;
  }

  /** True once the agent has gone quiet, which is `tail`'s exit condition. */
  update(update: SessionUpdate): boolean {
    const p = this.paint;
    switch (update.kind) {
      case "message_start":
        this.closeThinking();
        if (update.role === "assistant") this.line(p.dim("assistant"));
        else if (update.role === "user") this.line(p.dim("you"));
        return false;

      case "text_delta":
        this.closeThinking();
        this.raw(sanitize(update.delta));
        return false;

      case "thinking_delta":
        if (!this.showThinking) return false;
        if (!this.thinkingOpen) {
          this.line(p.dim("thinking"));
          this.thinkingOpen = true;
        }
        this.raw(p.dim(sanitize(update.delta)));
        return false;

      case "message_end":
        this.closeThinking();
        this.newline();
        return false;

      case "tool_execution_start": {
        this.closeThinking();
        this.toolStarts.set(update.toolCallId, { name: update.toolName, at: Date.now() });
        const summary = summarizeArgs(update.args);
        this.line(`  ${p.cyan("•")} ${p.bold(sanitize(update.toolName))}${summary ? `  ${p.dim(summary)}` : ""}`);
        return false;
      }

      case "tool_execution_end": {
        const started = this.toolStarts.get(update.toolCallId);
        this.toolStarts.delete(update.toolCallId);
        const name = sanitize(started?.name ?? "tool");
        const took = started ? formatDuration(Date.now() - started.at) : "—";
        const detail = summarizeResult(update.result);
        const mark = update.isError ? p.red("✗") : p.green("✓");
        this.line(
          `  ${mark} ${sanitize(name)}  ${p.dim(took)}${detail ? `  ${update.isError ? p.red(detail) : p.dim(detail)}` : ""}`,
        );
        return false;
      }

      case "compaction_start":
        this.line(p.dim("  compacting the context…"));
        return false;
      case "compaction_end":
        this.line(update.ok ? p.dim("  compacted") : p.yellow("  compaction failed"));
        return false;

      case "auto_retry_start":
        this.line(p.yellow(`  retrying (${update.attempt}/${update.maxAttempts})`));
        return false;

      case "queue_update": {
        const queued = update.steering.length + update.followUp.length;
        if (queued > 0) this.line(p.dim(`  ${queued} message${queued === 1 ? "" : "s"} queued`));
        return false;
      }

      case "extension_error":
        this.line(`  ${p.red("extension")} ${sanitize(update.extension)}: ${firstLine(update.message)}`);
        return false;

      case "agent_end":
        if (update.willRetry) this.line(p.dim("  turn ended, retrying"));
        return false;

      case "agent_settled":
        this.closeThinking();
        this.newline();
        this.line(p.dim("— settled"));
        return true;

      default:
        return false;
    }
  }

  dialog(request: UiDialogRequest & { path?: string }): void {
    const p = this.paint;
    this.line(`  ${p.magenta("?")} ${request.method}: ${firstLine(request.title)}`);
    if (request.method === "select") {
      for (const option of request.options) this.line(`      ${p.dim("·")} ${firstLine(option, 80)}`);
    }
    if (request.method === "confirm" && request.message) this.line(`      ${p.dim(firstLine(request.message, 80))}`);
    this.line(p.dim("      waiting for an answer in the app (`tail` does not answer dialogs)"));
  }

  event(event: UiFireAndForget): void {
    const p = this.paint;
    switch (event.method) {
      case "notify": {
        const colour = event.level === "error" ? p.red : event.level === "warning" ? p.yellow : p.dim;
        this.line(`  ${colour(event.level)} ${firstLine(event.message)}`);
        return;
      }
      case "setTitle":
        this.line(p.dim(`  title: ${firstLine(event.title, 80)}`));
        return;
      case "setStatus":
        if (event.text) this.line(p.dim(`  ${sanitize(event.key)}: ${firstLine(event.text, 80)}`));
        return;
      case "setWidget":
        for (const widgetLine of event.lines ?? []) this.line(p.dim(`  ${firstLine(widgetLine, 100)}`));
        return;
      default:
        return;
    }
  }

  /** Finish any partial line, so a shell prompt does not land mid-sentence. */
  finish(): void {
    this.newline();
  }

  private closeThinking(): void {
    if (!this.thinkingOpen) return;
    this.thinkingOpen = false;
    this.newline();
  }

  private raw(text: string): void {
    if (text === "") return;
    this.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private newline(): void {
    if (this.atLineStart) return;
    this.write("\n");
    this.atLineStart = true;
  }

  private line(text: string): void {
    this.newline();
    this.write(`${text}\n`);
    this.atLineStart = true;
  }
}
