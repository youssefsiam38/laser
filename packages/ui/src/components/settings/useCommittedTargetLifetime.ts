"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { deviceStore } from "@/runtime/device-storage";

interface TargetHandle {
  key: string;
  incarnation: symbol;
}

export interface CommittedTargetLease {
  readonly handle: TargetHandle;
  readonly activation: symbol;
}

export interface CommittedTargetLifetime {
  /** Capture only for this render incarnation after it committed. */
  capture(): CommittedTargetLease | undefined;
  /** True only while the exact committed handle and activation remain current. */
  isCurrent(lease: CommittedTargetLease | undefined): lease is CommittedTargetLease;
}

/**
 * Fences Settings work to one committed target and environment activation.
 *
 * The returned closures are bound to this render's handle. An old callback
 * invoked after A → B → A therefore cannot borrow the successor A's token.
 * Same-environment reconnects preserve the token; first activation, namespace
 * switches and capability narrowing retire it and commit a fresh incarnation.
 */
export function useCommittedTargetLifetime(key: string): CommittedTargetLifetime {
  const current = useRef<CommittedTargetLease | undefined>(undefined);
  const initial = deviceStore.status();
  const [lifecycle, setLifecycle] = useState(() => ({ active: initial.active, version: 0 }));
  const handle = useMemo<TargetHandle>(() => ({ key, incarnation: Symbol(key) }), [key, lifecycle.version]);

  // Subscribe before activating this handle. Every invalidating event retires
  // permission synchronously; the state update re-arms only after a commit.
  useLayoutEffect(() => deviceStore.subscribe((event) => {
    if (event.kind === "activated" && event.transition === "same") return;
    current.current = undefined;
    setLifecycle((previous) => ({
      active: event.kind === "activated",
      version: previous.version + 1,
    }));
  }), []);

  useLayoutEffect(() => {
    if (!lifecycle.active) {
      current.current = undefined;
      return undefined;
    }
    const lease: CommittedTargetLease = { handle, activation: Symbol("settings-target-activation") };
    current.current = lease;
    return () => {
      if (current.current === lease) current.current = undefined;
    };
  }, [handle, lifecycle.active]);

  return useMemo(() => ({
    capture: () => {
      const lease = current.current;
      return lease?.handle === handle ? lease : undefined;
    },
    isCurrent: (lease: CommittedTargetLease | undefined): lease is CommittedTargetLease =>
      lease !== undefined && current.current === lease && lease.handle === handle,
  }), [handle]);
}
