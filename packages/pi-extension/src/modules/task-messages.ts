/**
 * The words a background command puts in front of the model (RP-6, D-162).
 *
 * Kept apart from the module that runs commands because they are a different
 * kind of decision: what a person or a model reads when something is promoted,
 * when it ends, and when it was asked not to be told. Changing the sentence a
 * model reads should not mean editing the file that spawns processes.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Bytes of the command shown as a row's title. */
export const TITLE_MAX = 80;
/** Lines of output carried in a promotion or an exit message. */
export const PROMOTED_TAIL_LINES = 40;

export type StoppedBy = "agent" | "person" | "turn" | "shutdown";

/** What the model needs of a command to be told about it. */
export interface DescribedTask {
  id: string;
  command: string;
  status: "running" | "completed" | "failed" | "stopped";
  exitCode: number | null | undefined;
  stoppedBy?: StoppedBy;
  error?: string;
}

export function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, "");
}

export function firstLine(command: string): string {
  const line = command.split("\n").find((l) => l.trim().length > 0)?.trim() ?? command.trim();
  if (!line) return "(empty command)";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}



export const STOP_REASONS: Readonly<Record<StoppedBy, string>> = {
  agent: "the agent stopped it",
  person: "you stopped it",
  turn: "the turn was cancelled",
  shutdown: "the session ended",
};



export function exitText(task: DescribedTask, held: string): string {
  const outcome =
    task.status === "completed"
      ? `exited with code ${task.exitCode ?? 0}`
      : task.status === "stopped"
        ? `was stopped (${STOP_REASONS[task.stoppedBy ?? "agent"]})`
        : typeof task.exitCode === "number"
          ? `exited with code ${task.exitCode}`
          : `failed: ${task.error ?? "it did not finish"}`;
  const tail = lastLines(held, PROMOTED_TAIL_LINES);
  return [
    `Background task ${task.id} (${firstLine(task.command)}) ${outcome}.`,
    tail ? `Last lines:\n${tail}` : "(no output)",
    `Use task_output ${task.id} for more.`,
  ].join("\n");
}

export function promotedText(task: DescribedTask, seconds: number, held: string): string {
  const tail = lastLines(held, PROMOTED_TAIL_LINES);
  return [
    `Still running after ${formatSeconds(seconds)} s; it continues as background task ${task.id}. Output so far (last lines):`,
    tail || "(no output yet)",
    followGuidance(task.id),
  ].join("\n");
}

/** The sentence the model reads the moment a task goes to the background: carry on; the exit comes to you. */
export function followGuidance(taskId: string): string {
  return (
    `Do not wait for task ${taskId}. Carry on with your own work; when it exits, its status, exit code and the last lines of its output will be sent to you as a message. ` +
    `Use task_output ${taskId} to read its output meanwhile, or task_stop ${taskId} to end it.`
  );
}

/** The same moment for a task the model asked not to hear from. */
export function quietGuidance(taskId: string): string {
  return (
    `You asked not to be told when task ${taskId} exits: its ending is recorded and shown to you with your next turn, and never starts one. ` +
    `Use task_output ${taskId} to read its output, or task_stop ${taskId} to end it.`
  );
}

export function text(value: string): AgentToolResult<Record<string, unknown>>["content"] {
  return [{ type: "text", text: value }];
}
