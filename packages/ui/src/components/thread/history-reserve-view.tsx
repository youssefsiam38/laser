import { ConversationSkeleton } from "@/components/assistant-ui/elements/loading-state.js";

function ReserveCard({ loading }: { loading: boolean }) {
  return (
    <div
      role={loading ? "status" : undefined}
      aria-live={loading ? "polite" : undefined}
      aria-busy={loading || undefined}
      className="mx-auto flex w-full max-w-(--measure-prose) flex-col gap-5 rounded-xl border border-line bg-bg p-4 text-sm text-ink-2"
    >
      <span className="font-medium">
        {loading ? "Loading earlier messages…" : "Earlier messages load as you scroll"}
      </span>
      {loading ? <div aria-hidden="true"><ConversationSkeleton label="Loading earlier messages" className="gap-5 py-0" /></div> : (
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
  );
}

/**
 * The visible part of unloaded earlier history. Its parent owns the exact
 * virtual height. While a request is live, a zero-height sticky sibling keeps
 * the designed state in view without changing transcript geometry; the
 * unloaded-range card itself remains ordinary readable content.
 *
 * `guidance` is false when reading upwards cannot load anything right now (the
 * producer refused this window's base): the range stays, because the history is
 * real, and the promise goes, because it is not true until the person re-reads.
 */
export function HistoryReserve({ height, loading, guidance = true }: { height: number; loading: boolean; guidance?: boolean }) {
  if (height < 1 && !loading) return null;
  return (
    <>
      {loading && (
        <div data-slot="history-reserve-loading" className="sticky top-4 z-10 h-0 px-4">
          <ReserveCard loading />
        </div>
      )}
      {height >= 1 && (
        <div
          data-slot="history-reserve"
          data-loading={loading || undefined}
          style={{ height, flexShrink: 0 }}
          className="relative"
        >
          {!loading && guidance && <div className="sticky top-4"><ReserveCard loading={false} /></div>}
        </div>
      )}
    </>
  );
}
