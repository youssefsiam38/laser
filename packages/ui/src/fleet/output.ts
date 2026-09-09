"use client";
/**
 * Following a background task's output.
 *
 * Reads are ranged and bounded — a command can print gigabytes — and a
 * follower re-reads whenever the task's `outputBytes` grows, so nothing polls
 * while the process is quiet. What is kept on screen is the tail: the head of
 * a build log is not what you opened the row for.
 */
import { TASK_OUTPUT_MAX_BYTES, PRODUCT_NAME } from "@lasercode/protocol";
import { useEffect, useRef, useState } from "react";

import { useLaserStable } from "../runtime/index.js";

/** How much of a task's tail a follower keeps on screen. */
export const TAIL_BYTES = TASK_OUTPUT_MAX_BYTES;

export interface TaskOutput {
  text: string;
  /** Total size the host reported. */
  bytes: number | undefined;
  /** The text begins after byte 0: the head was not read. */
  fromByte: number;
  loading: boolean;
  error: string | undefined;
}

const EMPTY: TaskOutput = { text: "", bytes: undefined, fromByte: 0, loading: false, error: undefined };

export interface UseTaskOutputOptions {
  /** The task's own size claim; a change triggers a re-read of the tail. */
  bytes: number | undefined;
  /** Off while the row is collapsed: a fleet of twenty rows must not read twenty logs. */
  enabled?: boolean;
  /**
   * Bump to read again from scratch. A failed read is the only state a person
   * can act on, and "Try again" has to mean something.
   */
  reloadToken?: number;
}

/**
 * One task's tail, kept current. `path` is the session the task belongs to;
 * the host refuses a read from anywhere else.
 */
export function useTaskOutput(path: string | undefined, id: string | undefined, options: UseTaskOutputOptions): TaskOutput {
  const { actions } = useLaserStable();
  const { bytes, enabled = true, reloadToken = 0 } = options;
  const [output, setOutput] = useState<TaskOutput>(EMPTY);
  /** The end of what we hold, so a follower appends instead of re-reading. */
  const held = useRef<{ id: string; end: number; text: string; fromByte: number } | undefined>(undefined);

  useEffect(() => {
    if (!path || !id || !enabled) return;
    if (reloadToken > 0) held.current = undefined;
    let cancelled = false;
    setOutput((current) => ({ ...current, loading: current.text === "" }));
    void (async () => {
      const previous = held.current?.id === id ? held.current : undefined;
      let from = 0;
      const known = bytes ?? previous?.end;
      if (previous && bytes !== undefined && bytes >= previous.end) from = previous.end;
      else if (known !== undefined) from = Math.max(0, known - TAIL_BYTES);
      try {
        const chunk = await actions.tasks.output(path, id, from);
        if (cancelled) return;
        const contiguous = previous !== undefined && chunk.from === previous.end && chunk.from > 0;
        const appended = contiguous ? previous.text + chunk.chunk : chunk.chunk;
        const fromByte = contiguous ? previous.fromByte : chunk.from;
        // Keep the tail bounded in memory as well as on the wire.
        const trimmed = appended.length > TAIL_BYTES * 2 ? appended.slice(appended.length - TAIL_BYTES) : appended;
        const end = chunk.from + byteLength(chunk.chunk);
        held.current = { id, end, text: trimmed, fromByte: trimmed === appended ? fromByte : end - byteLength(trimmed) };
        setOutput({ text: trimmed, bytes: chunk.bytes, fromByte: held.current.fromByte, loading: false, error: undefined });
      } catch (error) {
        if (cancelled) return;
        setOutput((current) => ({ ...current, loading: false, error: readError(error) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, path, id, bytes, enabled, reloadToken]);

  // A collapsed row forgets what it held: reopening it reads the current tail,
  // which is what you wanted, not the tail from ten minutes ago.
  useEffect(() => {
    if (enabled) return;
    held.current = undefined;
    setOutput(EMPTY);
  }, [enabled]);

  return output;
}

/**
 * What went wrong, and what happens next — never a transport's own words.
 * The host's own refusals are already written for a person, so they pass
 * through; what does not is the socket underneath, which says "WebSocket
 * closed" every time a laptop sleeps.
 */
function readError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/websocket|socket|not connected|connection/i.test(message)) {
    return `The host is not answering right now. ${PRODUCT_NAME} is reconnecting; this reloads itself when it does.`;
  }
  if (/timed out|timeout/i.test(message)) return "The host did not answer in time. It may be busy; try again in a moment.";
  if (/abort/i.test(message)) return "That read was cancelled.";
  return message;
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}
