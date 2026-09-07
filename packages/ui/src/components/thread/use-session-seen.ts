import { useEffect, useRef } from "react";

/** Mounted by the actual transcript: a selected session behind Settings isn't seen.
 * Stable running/dialog keys avoid acknowledgement traffic on each streamed token.
 */
export function useSessionSeen({ path, seq, running, dialogs, ready, covered, markSeen }: {
  path: string | undefined; seq: number; running: boolean; dialogs: string;
  ready: boolean; covered: boolean;
  markSeen: (path: string, seq: number, force?: boolean) => void;
}) {
  const settledSeq = running ? 0 : seq;
  const latestSeq = useRef(seq);
  latestSeq.current = seq;
  useEffect(() => {
    if (!path || !ready || covered) return;
    const acknowledge = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      // Force on activation/dialog changes, even if no new transcript seq exists.
      // This only withdraws a reminder; the host preserves unanswered dialogs.
      markSeen(path, latestSeq.current, true);
    };
    acknowledge();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
    // seq is intentionally sampled only at these visible lifecycle boundaries.
  }, [path, settledSeq, running, dialogs, ready, covered, markSeen]);
}
