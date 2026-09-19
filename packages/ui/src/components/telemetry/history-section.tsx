import { useEffect, useMemo, useRef } from "react";
import { History, RefreshCw } from "lucide-react";
import type { TelemetryHistory } from "@lasercode/protocol";

import { CheckpointHistory } from "@/components/assistant-ui/elements/checkpoint-history";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useLaserStable, useLaserState, useSessionMeta, useWholeTranscriptRefusal } from "@/runtime";
import { useShell } from "@/components/shell/shell-context.js";
import { historyRows } from "@/components/shell/model.js";

import { count, historyHeader } from "./format.js";
import { TelemetrySection } from "./section.js";

/**
 * History counts come from the authority. The tree is the loaded page, for
 * fork/jump — that projection is not a session total (L3).
 */
export function HistorySection({ history }: { history?: TelemetryHistory | undefined }) {
  const partial = useLaserState((s) => {
    const page = s.current ? s.open[s.current]?.history : undefined;
    return Boolean(page && (!page.complete || page.branchesUnloaded));
  });
  const { actions } = useLaserStable();
  const wholeTranscript = useWholeTranscriptRefusal();
  const meta = useSessionMeta();
  const shell = useShell();
  const entries = useLaserState((s) => (s.current ? s.open[s.current]?.entries : undefined));
  const snapshots = useRef(new WeakMap<readonly unknown[], ReturnType<typeof historyRows>>());
  const rows = useMemo(() => {
    if (!entries) return [];
    let cached = snapshots.current.get(entries);
    if (!cached) {
      cached = historyRows(entries);
      snapshots.current.set(entries, cached);
    }
    return cached;
  }, [entries]);
  const recordsHeld = entries?.length ?? 0;

  const refresh = useRef(actions.refreshEntries);
  refresh.current = actions.refreshEntries;
  const path = meta.path;
  const running = meta.running;
  useEffect(() => {
    if (shell.historyOpen && path) void refresh.current({ tail: true });
  }, [shell.historyOpen, path, running]);

  return (
    <TelemetrySection
      id="history"
      title="History"
      icon={History}
      number={historyHeader(history, recordsHeld, rows.length)}
      open={shell.historyOpen}
      onOpenChange={shell.setHistoryOpen}
      padded={false}
      action={
        shell.historyOpen ? (
          <TooltipIconButton
            tooltip={wholeTranscript.paused ? "Refresh paused while this window is low on memory" : "Refresh history"}
            size="icon-xs"
            className="text-ink-3"
            disabled={wholeTranscript.paused}
            onClick={() => void actions.refreshEntries()}
          >
            <RefreshCw />
          </TooltipIconButton>
        ) : null
      }
    >
      <dl className="mb-3 grid grid-cols-2 gap-2 px-4" data-slot="telemetry-history-counts">
        <Count label="Prompts" value={history ? count(history.prompts) : "—"} />
        <Count
          label="Records"
          value={historyHeader(history, recordsHeld, rows.length)}
          note={history && recordsHeld < history.records ? "this client" : undefined}
        />
        <Count label="Compactions" value={history ? count(history.compactions) : "—"} />
        <Count label="Branches" value={history ? count(history.branches) : "—"} />
      </dl>
      {partial && !history ? <p className="mb-3 px-4 text-xs leading-4 text-ink-2">{count(rows.length)} loaded</p> : null}
      {wholeTranscript.paused && (
        <p data-slot="history-refresh-paused" className="mb-3 px-4 text-sm text-ink-2">
          {wholeTranscript.explanation}
        </p>
      )}
      <CheckpointHistory
        rows={rows}
        busy={meta.running || meta.compacting}
        onFork={(id) => void actions.fork(id)}
        onJump={(id) => void actions.jump(id)}
      />
    </TelemetrySection>
  );
}

function Count({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
      <dt className="text-xs leading-4 text-ink-3">{label}</dt>
      <dd data-slot={label === "Records" ? "telemetry-held-records" : undefined} className="font-mono text-xs text-ink tnum">
        {value}
        {note ? <span className="ms-1 font-sans text-ink-3">{note}</span> : null}
      </dd>
    </div>
  );
}
