"use client";
/**
 * Conversations kept on this device (RP-10), in Settings → This device.
 *
 * Laser keeps the recent end of a conversation you have already read, so
 * coming back to it is instant instead of a wait on the host. That is a
 * per-device thing — this laptop, this phone, this browser profile — which is
 * why it lives on the one tab that is about the device rather than a project.
 *
 * Three honest states this screen exists to say out loud:
 *
 * - **where it is kept**: encrypted with a key the operating system holds, or
 *   plainly in the browser's own storage, which nothing here pretends is
 *   encrypted;
 * - **what the limits are**: Laser's own, or the tighter ones an organisation's
 *   host asked for;
 * - **why nothing is kept**, when nothing is: the policy, the browser, or data
 *   from an earlier session that could not be checked. Every one of those has a
 *   sentence and, where there is one, a next step.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Trash2 } from "lucide-react";

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
import { tailCache, type DeviceCacheCounters, type TailRefusal } from "@/runtime/tail-cache";

/** Why nothing is kept, written for a person, with what to do about it. */
function refusalCopy(refusal: TailRefusal): { title: string; detail: string } {
  switch (refusal) {
    case "policy":
      return {
        title: "Conversations are not kept on this device",
        detail: `The environment you are connected to does not allow conversation content to be stored on a device. ${PRODUCT_NAME} reads every conversation from its host instead.`,
      };
    case "bounds":
      return {
        title: "Conversations are not kept on this device",
        detail: "The environment you are connected to has set its device limits to nothing, so there is no room to keep anything here.",
      };
    case "encryption":
      return {
        title: "Encrypted storage is required, and this device has none",
        detail: "The environment you are connected to requires conversations to be stored encrypted on a device. This one cannot prove that, so nothing is kept here.",
      };
    case "storage":
      return {
        title: "This browser will not store anything",
        detail: "Site data may be switched off, this may be a private window, or another window is holding an older version of the storage open. Conversations still load from the host, just not instantly.",
      };
    case "purge":
      return {
        title: "Data from an earlier session could not be checked",
        detail: "Something is stored here that this version could not verify, so nothing is being read or written. Clearing what is stored fixes it.",
      };
    case "unavailable":
      return {
        title: "This browser will not store anything",
        detail: "Nothing is kept on this device, and conversations load from the host as usual.",
      };
    case "inactive":
      return {
        title: "Not connected yet",
        detail: "This will say what is kept on this device once there is a connection.",
      };
  }
}

function storageLine(counters: DeviceCacheCounters): string {
  const encryption = counters.encryption;
  if (encryption.kind === "os-backed") return `encrypted with a key ${encryption.store} keeps for ${PRODUCT_NAME}`;
  if (encryption.kind === "unavailable") return "stored unencrypted on this computer";
  return "kept by this browser, unencrypted";
}

export function DeviceCacheSetting({ className }: { className?: string }) {
  const [counters, setCounters] = useState<DeviceCacheCounters>(() => tailCache.counters());
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [stuck, setStuck] = useState(false);

  const read = useCallback(() => setCounters(tailCache.counters()), []);
  useEffect(() => {
    read();
    return tailCache.subscribe(read);
  }, [read]);

  const clear = useCallback(async () => {
    setConfirming(false);
    setStuck(false);
    setClearing(true);
    try {
      const cleared = await tailCache.clear("environment");
      setStuck(!cleared);
    } finally {
      setClearing(false);
      read();
    }
  }, [read]);

  const bounds = counters.bounds;
  const open = counters.status === "open";
  const refusal = counters.status === "refused" ? counters.refusal : counters.status === "closed" ? "inactive" : undefined;
  const copy = refusal ? refusalCopy(refusal) : undefined;
  const rows = open && bounds
    ? [
      { label: "kept here", value: `${counters.records.toLocaleString()} of ${bounds.sessions.toLocaleString()}`, typed: true, emphasis: true },
      { label: "size", value: `${formatBytes(counters.bytes)} of ${formatBytes(bounds.bytes)}`, typed: true },
      { label: "per conversation", value: `${bounds.entriesPerSession} messages, ${formatBytes(bounds.bytesPerSession)}`, typed: true },
      { label: "kept for", value: `${Math.round(bounds.ageMs / (60 * 60 * 1000))} hours`, typed: true },
      { label: "storage", value: storageLine(counters) },
      ...(counters.lastClearedAt ? [{ label: "last cleared", value: dateTime(counters.lastClearedAt) }] : []),
    ]
    : [];

  return (
    <section data-slot="device-cache-setting" aria-labelledby="device-cache-title" className={className}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <HardDrive aria-hidden="true" className="size-4 text-ink-3" />
          <h3 id="device-cache-title" className="text-base font-medium text-ink">
            Conversations on this device
          </h3>
        </div>

        <p className="text-sm leading-6 text-ink-2">
          The recent end of a conversation you have already read is kept here, so opening it again is instant instead of
          a wait. Everything you send, approve or change still goes to the host, and the host stays the only place your
          conversations really live.
        </p>

        {copy ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-ink">{copy.title}</p>
            <p className="text-sm leading-6 text-ink-2">{copy.detail}</p>
          </div>
        ) : (
          <>
            <SpecSheet rows={rows} className="mt-1" />
            {counters.encryption.kind === "unavailable" && (
              <p className="text-sm leading-6 text-attention">
                This computer has no keyring {PRODUCT_NAME} can use, so what is kept here is not encrypted: anything
                running as you can read it. {counters.encryption.reason}
              </p>
            )}
            {counters.encryption.kind === "not-applicable" && (
              <p className="text-sm leading-6 text-ink-2">
                Your browser owns this storage. {PRODUCT_NAME} does not encrypt it, and your browser may clear it at any
                time.
              </p>
            )}
          </>
        )}

        {stuck && (
          <p data-slot="device-cache-stuck" className="text-sm leading-6 text-attention">
            This browser is still holding on to the data. Close other {PRODUCT_NAME} windows and tabs, then try again.
          </p>
        )}

        <div className="mt-1">
          <Button
            type="button"
            size="sm"
            variant="destructive-ghost"
            className="gap-1.5 pointer-coarse:min-h-11"
            disabled={clearing || (counters.records === 0 && refusal !== "purge")}
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            {clearing ? "Clearing…" : "Clear cached conversations"}
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear cached conversations?</DialogTitle>
            <DialogDescription>
              This removes what {PRODUCT_NAME} has kept on this device
              {counters.records > 0 ? ` — ${counters.records.toLocaleString()} conversation${counters.records === 1 ? "" : "s"}, ${formatBytes(counters.bytes)}` : ""}
              . Your conversations themselves are on the host and are untouched; opening one will simply wait for it
              again the first time. Anything you have typed and not sent is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Keep them
            </Button>
            <Button type="button" variant="destructive" className="gap-1.5" onClick={() => void clear()}>
              <Trash2 /> Clear cached conversations
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
