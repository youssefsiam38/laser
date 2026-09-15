import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCopy {
  /** True for `resetMs` after a successful copy. */
  copied: boolean;
  /** Copies text; resolves true on success. */
  copy: (text: string) => Promise<boolean>;
  /**
   * Say that something was copied by another route — a whole body written to
   * the clipboard as a `Blob`, which never passes through `copy` — so the
   * action gives the same feedback, on the same clock, as any other copy.
   */
  markCopied: () => void;
  reset: () => void;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Copy-to-clipboard with a transient `copied` flag for the button icon swap. */
export function useCopy(resetMs = 1500): UseCopy {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setCopied(false);
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), resetMs);
  }, [resetMs]);

  const copy = useCallback(
    async (text: string) => {
      const ok = await writeClipboard(text);
      if (ok) markCopied();
      return ok;
    },
    [markCopied],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { copied, copy, markCopied, reset };
}
