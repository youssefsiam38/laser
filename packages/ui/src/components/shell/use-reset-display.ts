import { useEffect, useRef, useState } from "react";
import type { HostClient } from "@/client";
import type { ResetDisplay } from "./account-allowance.js";

const NAMESPACE = "account-usage-display";
/** Stored by the host on this machine, not in provider settings or a session. */
export function useResetDisplay(client: Pick<HostClient, "request" | "subscribe">) {
  const [display, setDisplay] = useState<ResetDisplay>("remaining");
  const [saveError, setSaveError] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    const start = revision.current;
    const adopt = (value: unknown) => {
      if (!live || !value || typeof value !== "object") return;
      const mode = (value as { resetDisplay?: unknown }).resetDisplay;
      if (mode === "remaining" || mode === "time") setDisplay(mode);
    };
    void client.request("pi/prefs/get", { namespace: NAMESPACE }).then(result => {
      if (revision.current === start) adopt(result.entries[0]?.value);
    }).catch(() => {});
    const off = client.subscribe((method, params) => {
      if (method !== "pi/prefs/updated") return;
      const entry = params as { namespace: string; value: unknown };
      if (entry.namespace !== NAMESPACE) return;
      revision.current++;
      adopt(entry.value);
    });
    return () => { live = false; off(); };
  }, [client]);
  const choose = (resetDisplay: ResetDisplay) => {
    const edit = ++revision.current;
    setDisplay(resetDisplay);
    setSaveError(false);
    void client.request("pi/prefs/set", { namespace: NAMESPACE, value: { resetDisplay } }).catch(() => {
      if (edit === revision.current) setSaveError(true);
    });
  };
  return { display, choose, saveError };
}
