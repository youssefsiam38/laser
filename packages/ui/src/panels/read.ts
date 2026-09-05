/**
 * Reading refs for stream and document bodies. Reads are ranged and bounded
 * (docs/ux-panels.md: "a stream can be gigabytes"); a follower re-reads the
 * tail whenever the panel's `bytes` grows, so no polling is needed while the
 * producer keeps emitting. Client-local `inline:` refs resolve without the host.
 */
import { PANEL_READ_MAX_BYTES } from "@piorbit/protocol";
import { useEffect, useRef, useState } from "react";
import { usePanelActions } from "./PanelsProvider.js";

/** How much of a stream's tail a follower keeps on screen. */
export const TAIL_BYTES = 256 * 1024;

export interface RefContent {
  text: string;
  /** Total size the host reported. */
  bytes: number | undefined;
  /** The text begins after byte 0: the head was not read. */
  fromByte: number;
  loading: boolean;
  error: string | undefined;
  /** For binary documents: a data: URL. */
  dataUrl: string | undefined;
}

export interface UseRefContentOptions {
  /** The panel's own size claim; a change triggers a re-read of the tail. */
  bytes?: number | undefined;
  /** Keep only the tail (streams) rather than the head (documents). */
  tail?: boolean;
  /** Read as binary and hand back a data URL. */
  mediaType?: string | undefined;
  /** Poll while true and the producer does not report `bytes`. */
  follow?: boolean;
  enabled?: boolean;
  /**
   * Bump to read again from scratch. A failed read is the only state a person
   * can act on, and "Try again" has to mean something.
   */
  reloadToken?: number;
}

const EMPTY: RefContent = { text: "", bytes: undefined, fromByte: 0, loading: false, error: undefined, dataUrl: undefined };

export function useRefContent(path: string, ref: string | undefined, options: UseRefContentOptions = {}): RefContent {
  const { readRef } = usePanelActions();
  const [content, setContent] = useState<RefContent>(ref ? { ...EMPTY, loading: true } : EMPTY);
  const { bytes, tail = false, mediaType, follow = false, enabled = true, reloadToken = 0 } = options;
  const binary = mediaType !== undefined && /^(image|audio|video|application\/pdf)/.test(mediaType);
  // The end of what we hold, so a follower appends instead of re-reading.
  const held = useRef<{ ref: string; end: number; text: string; fromByte: number } | undefined>(undefined);

  useEffect(() => {
    if (!ref || !enabled) return;
    // A retry starts over rather than appending to what half-arrived.
    if (reloadToken > 0) held.current = undefined;
    let cancelled = false;
    const run = async (): Promise<void> => {
      const previous = held.current?.ref === ref ? held.current : undefined;
      let from = 0;
      if (tail) {
        const known = bytes ?? previous?.end;
        if (previous && bytes !== undefined && bytes >= previous.end) from = previous.end;
        else if (known !== undefined) from = Math.max(0, known - TAIL_BYTES);
      }
      const to = from + (tail ? TAIL_BYTES : PANEL_READ_MAX_BYTES);
      try {
        const result = await readRef(path, ref, from, to);
        if (cancelled) return;
        if (binary) {
          held.current = { ref, end: result.from + result.chunk.length, text: "", fromByte: result.from };
          const url = result.encoding === "base64" ? `data:${mediaType};base64,${result.chunk}` : undefined;
          setContent({ text: "", bytes: result.bytes, fromByte: result.from, loading: false, error: undefined, dataUrl: url });
          return;
        }
        const appended = previous && result.from === previous.end && result.from > 0 ? previous.text + result.chunk : result.chunk;
        const fromByte = previous && result.from === previous.end && result.from > 0 ? previous.fromByte : result.from;
        // Keep the tail bounded in memory as well as on the wire.
        const trimmed = tail && appended.length > TAIL_BYTES * 2 ? appended.slice(appended.length - TAIL_BYTES) : appended;
        const end = result.from + byteLength(result.chunk);
        held.current = { ref, end, text: trimmed, fromByte: trimmed === appended ? fromByte : end - byteLength(trimmed) };
        setContent({ text: trimmed, bytes: result.bytes, fromByte: held.current.fromByte, loading: false, error: undefined, dataUrl: undefined });
      } catch (error) {
        if (cancelled) return;
        setContent((c) => ({ ...c, loading: false, error: readError(error) }));
      }
    };
    void run();
    // Without a size claim, a follower has nothing to react to: poll gently.
    const timer = follow && bytes === undefined ? setInterval(() => void run(), 2000) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, ref, bytes, tail, binary, mediaType, follow, enabled, reloadToken, readRef]);

  return content;
}

/**
 * What went wrong, and what happens next — never a transport's own words.
 *
 * The host's refusals are already written for a person ("That file is gone or
 * unreadable…"), so they are passed through unchanged. What is not is the
 * socket underneath: "WebSocket closed" and "Request timed out" are true and
 * useless, and they are what a person sees every time their laptop sleeps.
 */
function readError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/websocket|socket|not connected|connection/i.test(message)) {
    return "The host is not answering right now. piorbit is reconnecting; this reloads itself when it does.";
  }
  if (/timed out|timeout/i.test(message)) {
    return "The host did not answer in time. It may be busy; try again in a moment.";
  }
  if (/abort/i.test(message)) {
    return "That read was cancelled.";
  }
  return message;
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}
