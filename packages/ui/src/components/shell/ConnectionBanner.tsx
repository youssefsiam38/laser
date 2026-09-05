import { useEffect, useRef } from "react";

import { usePiorbitState } from "@/runtime";

/**
 * One quiet line under the top bar while the host is unreachable. Absent when
 * connected: the banner is the only thing in the shell that says "connection".
 */
export function ConnectionBanner() {
  const connection = usePiorbitState((s) => s.connection);
  const everOpen = useRef(false);
  useEffect(() => {
    if (connection === "open") everOpen.current = true;
  }, [connection]);

  if (connection === "open") return null;

  const first = !everOpen.current;
  const title = first
    ? "Connecting to the host…"
    : connection === "connecting"
      ? "Reconnecting to the host…"
      : "Disconnected from the host";
  const detail = first
    ? "The desktop host serves this page and runs Pi."
    : connection === "connecting"
      ? "Sessions resume from where they left off."
      : "Retrying in the background.";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-8 shrink-0 items-center gap-2 bg-[color-mix(in_oklab,var(--attention)_9%,var(--bg))] px-4 text-xs hairline-b"
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention motion-safe:animate-attention" />
      <span className="font-medium text-ink">{title}</span>
      <span className="hidden truncate text-ink-2 sm:inline">{detail}</span>
    </div>
  );
}
