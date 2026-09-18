import { ConversationSkeleton } from "@/components/assistant-ui/elements/loading-state.js";

/**
 * The visible part of unloaded earlier history. Its parent owns the exact
 * virtual height; this sticky conversation-shaped state means a thumb drag
 * through that range never exposes an empty sheet.
 */
export function HistoryReserve({ height, loading }: { height: number; loading: boolean }) {
  if (height < 1) return null;
  return (
    <div
      data-slot="history-reserve"
      data-loading={loading || undefined}
      aria-hidden={!loading || undefined}
      style={{ height, flexShrink: 0 }}
      className="relative"
    >
      <div
        className="sticky top-4 mx-auto flex w-full max-w-(--measure-prose) flex-col gap-5 rounded-xl border border-line bg-bg p-4 text-sm text-ink-2"
      >
        <span className="font-medium">
          {loading ? "Loading earlier messages…" : "Earlier messages load as you scroll"}
        </span>
        {loading ? <ConversationSkeleton label="Loading earlier messages" className="gap-5 py-0" /> : (
          <div aria-hidden="true" className="flex flex-col gap-5">
            <div className="flex w-4/5 flex-col gap-2.5">
              <div className="h-2 w-full rounded-full bg-line" />
              <div className="h-2 w-11/12 rounded-full bg-line" />
              <div className="h-2 w-2/3 rounded-full bg-line" />
            </div>
            <div className="ms-auto w-3/5 rounded-xl bg-surface-2 p-4">
              <div className="h-2 w-full rounded-full bg-line" />
              <div className="mt-2.5 h-2 w-3/4 rounded-full bg-line" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
