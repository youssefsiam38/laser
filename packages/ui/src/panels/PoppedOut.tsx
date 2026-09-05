"use client";
/**
 * A popped-out panel's page (`#/panel/<path>/<id>`, D-20 "Every expanded
 * island can pop out"): the same island, filling its own tab, with identity
 * and state carried by the panel id. Tells the opener when it opens and
 * closes so the dock island can point at it and come back.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { useEffect, useMemo } from "react";

import { StatusRing } from "@/components/status";
import { useLaserStable, useLaserState } from "@/runtime";

import { Island } from "./islands/Island.js";
import { POPOUT_CHANNEL, parsePopoutHash, usePanelEntries } from "./PanelsProvider.js";

export function PoppedOutPanel({ hash }: { hash: string }) {
  const target = useMemo(() => parsePopoutHash(hash), [hash]);
  const { actions } = useLaserStable();
  const connection = useLaserState((s) => s.connection);
  const entries = usePanelEntries(target?.path);
  const entry = entries.find((e) => e.panel.id === target?.id);

  // Follow the session so its panels (declared and fallback) arrive here too.
  useEffect(() => {
    if (!target || connection !== "open") return;
    void actions.openSession(target.path);
  }, [actions, connection, target]);

  useEffect(() => {
    if (!target || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(POPOUT_CHANNEL);
    channel.postMessage({ type: "open", path: target.path, id: target.id });
    const bye = () => channel.postMessage({ type: "closed", path: target.path, id: target.id });
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      channel.close();
    };
  }, [target]);

  useEffect(() => {
    document.title = entry ? `${entry.panel.title} · ${PRODUCT_DISPLAY_NAME}` : PRODUCT_DISPLAY_NAME;
  }, [entry]);

  if (!target) {
    return (
      <Empty title="That link is not a panel" body="A popped-out panel link looks like #/panel/<session>/<id>. Open the app and pop the panel out again." />
    );
  }
  if (!entry) {
    return (
      <Empty
        title={connection === "open" ? "This panel is gone" : "Connecting to the host…"}
        body={connection === "open" ? "The extension that showed it has closed it, or the session ended. You can close this tab." : "The panel appears as soon as the session is open."}
        busy={connection !== "open"}
      />
    );
  }
  return (
    <div className="flex h-full w-full flex-col bg-bg text-ink">
      <Island entry={entry} size="maximized" frame="popout" />
    </div>
  );
}

function Empty({ title, body, busy = false }: { title: string; body: string; busy?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" aria-busy={busy || undefined}>
      <StatusRing status={busy ? "working" : "idle"} size={40} thickness={2} aria-hidden="true">
        <span className="font-mono text-xs text-ink-3">{busy ? "…" : "—"}</span>
      </StatusRing>
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-xs leading-4 text-ink-2">{body}</p>
      </div>
    </div>
  );
}
