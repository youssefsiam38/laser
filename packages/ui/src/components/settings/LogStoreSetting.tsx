"use client";
/**
 * The log store, in Settings (M16-T34, D-245).
 *
 * Everything the host records — every provider request with its whole
 * conversation, every tool run, session events, worker output — lives in one
 * SQLite file beside the app's other state. On one machine that file reached
 * 27.7 GB in eight days and nothing in the app ever said so. It now has a
 * budget, and here is where a person sees what it is holding and empties it.
 *
 * The numbers come from `pi/logs/stats`, which the host answers without
 * opening a worker; the limits come with them, so this never hard-codes a
 * policy the host owns.
 */
import { PRODUCT_NAME, type LogStats } from "@lasercode/protocol";
import { useCallback, useEffect, useState } from "react";
import { Database, Trash2 } from "lucide-react";

import { SpecSheet } from "@/components/assistant-ui/elements/spec-sheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dateTime, formatBytes } from "@/format";
import { useLaserStable } from "@/runtime";

export function LogStoreSetting({ className }: { className?: string }) {
  const { client, actions } = useLaserStable();
  const [stats, setStats] = useState<LogStats>();
  const [unavailable, setUnavailable] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { stats: next } = await client.request("pi/logs/stats", {});
      setStats(next);
      setUnavailable(undefined);
    } catch (error) {
      setStats(undefined);
      setUnavailable(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = useCallback(async () => {
    setConfirming(false);
    setClearing(true);
    try {
      const { deleted } = await client.request("pi/logs/clear", {});
      actions.toast("info", `Cleared the log store: ${deleted.toLocaleString()} row${deleted === 1 ? "" : "s"} removed.`);
      await load();
    } catch (error) {
      actions.toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  }, [client, actions, load]);

  const retention = stats?.retention;
  const rows = stats
    ? [
        { label: "on disk", value: formatBytes(stats.bytes), typed: true, emphasis: true },
        { label: "rows", value: stats.total.toLocaleString(), typed: true },
        ...(retention?.retainedBodyBytes !== undefined && retention.bodyBudgetBytes !== undefined
          ? [{
              label: "request bodies",
              value: `${formatBytes(retention.retainedBodyBytes)} of ${formatBytes(retention.bodyBudgetBytes)}`,
              typed: true,
            }]
          : []),
        ...(stats.oldestAt ? [{ label: "oldest", value: dateTime(stats.oldestAt) }] : []),
      ]
    : [];

  return (
    <section data-slot="log-store-setting" aria-labelledby="log-store-title" className={className}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Database aria-hidden="true" className="size-4 text-ink-3" />
          <h3 id="log-store-title" className="text-base font-medium text-ink">
            Log store
          </h3>
        </div>

        <p className="text-sm leading-6 text-ink-2">
          Everything that crosses the wire is recorded on the computer running {PRODUCT_NAME}: every request sent to a
          model, every tool run, session events and worker output. It is what the Logs screen reads, and what the API
          request inspector opens from a message.
        </p>

        {unavailable ? (
          <p className="text-sm leading-6 text-ink-2">{unavailable}</p>
        ) : (
          <>
            <SpecSheet rows={rows} className="mt-1" />
            {retention && (
              <p className="text-sm leading-6 text-ink-2">
                {retention.bodiesPerSession !== undefined && retention.bodyBudgetBytes !== undefined ? (
                  <>
                    The full text of a request is kept for the {retention.bodiesPerSession} most recent requests in each
                    session, and for at most {formatBytes(retention.bodyBudgetBytes)} across all of them. Older requests
                    keep their summary — model, message count, size and timing — and the inspector says so when you open
                    one.{" "}
                  </>
                ) : null}
                Rows are removed after {retention.maxAgeDays} days, or once there are more than{" "}
                {retention.maxRows.toLocaleString()} of them.
              </p>
            )}
            <div className="mt-1">
              <Button
                type="button"
                size="sm"
                variant="destructive-ghost"
                className="gap-1.5"
                disabled={clearing || !stats}
                onClick={() => setConfirming(true)}
              >
                <Trash2 />
                {clearing ? "Clearing…" : "Clear the log store"}
              </Button>
            </div>
          </>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear the log store?</DialogTitle>
            <DialogDescription>
              This deletes every recorded request, tool run, session event and worker line
              {stats ? ` — ${stats.total.toLocaleString()} row${stats.total === 1 ? "" : "s"}, ${formatBytes(stats.bytes)}` : ""}
              {" "}and returns that space to the disk. Your conversations, projects and settings are untouched; the Logs
              screen and the API request inspector start again from the next request. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Keep the logs
            </Button>
            <Button type="button" variant="destructive" className="gap-1.5" onClick={() => void clear()}>
              <Trash2 /> Clear the log store
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
