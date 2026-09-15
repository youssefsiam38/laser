"use client";
/**
 * What the inspector shows when the store no longer keeps a request's body
 * (M16-T34, D-245).
 *
 * A provider request body is the whole conversation of that turn, so keeping
 * every one of them filled 27.7 GB of disk in eight days. The store now keeps
 * the recent ones in full and reduces the rest to what the row already knew.
 * That is a deliberate trade, not a loss or a failure — so this says what
 * happened, why, and shows the summary that was kept, rather than an error.
 */
import { Archive } from "lucide-react";
import type { LogBodySummary } from "@lasercode/protocol";

import { SpecSheet } from "@/components/assistant-ui/elements/spec-sheet";
import { dateTime, duration, formatBytes } from "@/format";
import { cn } from "@/lib/utils";

/** One sentence per reason, in the store's own terms and a person's words. */
function why(summary: LogBodySummary): string {
  switch (summary.reason) {
    case "session-limit":
      return "This session has had newer requests since, and the full text is kept for the most recent ones.";
    case "budget":
      return "Kept request bodies had reached the size limit for the whole store, so the oldest were released first.";
    case "over-ceiling":
      return "This request was larger than the size kept in full, so it was recorded without its text.";
    case "link-busy":
      return "The app was busy receiving this session's own updates when the request was captured, so its text was skipped and the request itself was still recorded.";
    case "summary-mode":
      return "This installation is set to keep request summaries only, so no request text is stored.";
    case "interrupted":
      return "The capture stopped before all of it had arrived, so no partial text was kept.";
    case "corrupt":
      return "What arrived did not match the size and fingerprint the capture announced, so none of it was kept.";
    case "unredacted":
      return "A credential-shaped field could not be removed from this request, so none of its text was kept. The request itself is still recorded.";
    default:
      return "The rows that referred to it were removed when older logs were cleaned up.";
  }
}

/** Grouped digits: an exact count a person can read and compare. */
function exactBytes(bytes: number): string {
  return `${bytes.toLocaleString()} bytes (${formatBytes(bytes)})`;
}

export function ReleasedBody({
  summary,
  variant = "page",
  className,
}: {
  summary: LogBodySummary;
  /** `page` fills the inspector; `panel` sits in the log detail pane. */
  variant?: "page" | "panel";
  className?: string;
}) {
  const rows = [
    ...(summary.model ? [{ label: "model", value: summary.model, typed: true }] : []),
    ...(summary.messages !== undefined
      ? [{ label: "messages", value: `${summary.messages}`, typed: true }]
      : []),
    { label: "size", value: exactBytes(summary.bytes), typed: true },
    ...(summary.sha256 ? [{ label: "fingerprint", value: summary.sha256, typed: true }] : []),
    ...(summary.at ? [{ label: "captured", value: dateTime(summary.at) }] : []),
    ...(summary.durationMs !== undefined ? [{ label: "took", value: duration(summary.durationMs), typed: true }] : []),
  ];
  return (
    <div
      data-slot="released-body"
      className={cn("flex min-w-0 flex-col gap-4", variant === "page" ? "mx-auto max-w-140 p-6" : "gap-3", className)}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Archive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="min-w-0">
          <h3 className={cn("font-medium text-ink", variant === "page" ? "text-base" : "text-sm")}>
            Only this request&rsquo;s summary was kept
          </h3>
          <p className="mt-1 text-sm leading-6 text-ink-2">
            {why(summary)} Everything below is what the log recorded about it at the time. The size and
            fingerprint describe the redacted copy this app would have kept, not the request as the
            provider received it.
          </p>
        </div>
      </div>

      <SpecSheet rows={rows} />

      {summary.summary && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="eyebrow">recorded line</span>
          <p className="text-sm leading-6 text-ink">{summary.summary}</p>
        </div>
      )}

      {summary.preview && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="eyebrow">first characters of the request</span>
          <p dir="ltr" className="typed wrap-break-word rounded-lg bg-surface-2 p-3 text-xs leading-5 text-ink-2">
            {summary.preview}
          </p>
        </div>
      )}
    </div>
  );
}
