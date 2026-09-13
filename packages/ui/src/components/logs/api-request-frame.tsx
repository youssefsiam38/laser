"use client";
/**
 * The parts of the API request inspector that are cheap enough to keep in the
 * first chunk (M16-T31).
 *
 * The inspector itself is the app's heaviest reading surface — the request
 * model, the provenance marker, the Handlebars template vocabulary it names
 * fields from, the JSON viewer — and a conversation opens without it. So
 * `ApiRequestDialog` keeps only the dialog frame and these two pieces, and
 * asks for the body when a person opens it.
 *
 * They live here rather than in either file because both use them: the frame
 * draws them while the body is on its way, and the body draws the same bar
 * (now live) while it fetches the capture. The person sees one dialog opening,
 * not a placeholder replaced by a page.
 */
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { dateTime } from "@/format";
import { cn } from "@/lib/utils";

export interface CaptureChoice {
  id: number;
  at: string;
  label: string;
}

/** The empty picker the frame draws while the inspector is on its way. */
export const NO_CAPTURES: readonly CaptureChoice[] = [];

/**
 * The capture picker and its refresh control. With no captures to offer it is
 * the same row, disabled — which is exactly what it looks like while either
 * the module or the capture is loading.
 */
export function ApiRequestCaptureBar({
  captures,
  selected,
  onSelect,
  loading,
  onRefresh,
}: {
  captures: readonly CaptureChoice[];
  selected?: number | undefined;
  onSelect?: ((id: number) => void) | undefined;
  loading: boolean;
  onRefresh?: (() => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-5 py-2">
      <label className="min-w-0 flex-1 text-xs text-ink-2">
        Captured request
        <select
          aria-label="Captured request"
          value={selected ?? ""}
          onChange={(event) => onSelect?.(Number(event.target.value))}
          disabled={!captures.length}
          className="ms-2 max-w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
        >
          {!captures.length && <option value="">No capture</option>}
          {captures.map((capture, index) => (
            <option key={capture.id} value={capture.id}>
              {index + 1} / {captures.length} · {dateTime(capture.at)} · {capture.label}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant="ghost"
        size="sm"
        disabled={loading}
        onClick={() => onRefresh?.()}
        aria-label="Refresh captured requests"
      >
        <RefreshCw className={cn(loading && "motion-safe:animate-busy")} />
        Refresh
      </Button>
    </div>
  );
}

/** The dialog's waiting body: one loader, centred in the space the request will fill. */
export function ApiRequestLoading({ label }: { label: string }) {
  return (
    <div className="grid flex-1 place-items-center">
      <GenerationLoader label={label} />
    </div>
  );
}
