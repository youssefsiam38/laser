import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ConnectionState } from "../client.js";
import type { AppState } from "../store.js";
import type { TranscriptHoldObserver } from "../transcript-hold-ledger.js";
import { holdsTranscript, pinReason, type ViewCacheEnvironment } from "./view-cache.js";

export function releasableTranscriptPaths(
  state: AppState,
  held: ReadonlySet<string>,
  landings: ReadonlySet<string>,
  attempted: ReadonlySet<string>,
  environment: ViewCacheEnvironment,
): string[] {
  const releasable: string[] = [];
  for (const path of held) {
    if (landings.has(path) || attempted.has(path) || holdsTranscript(pinReason(state, path, environment))) continue;
    releasable.push(path);
  }
  return releasable;
}

interface TranscriptMembershipDeps {
  connection: ConnectionState;
  read(): AppState;
  subscribe(listener: () => void): () => void;
  environment: ViewCacheEnvironment;
  detach(path: string): Promise<unknown>;
  onError(error: unknown): void;
}

export interface TranscriptMembership {
  observer: TranscriptHoldObserver;
  /** Keep an admitted path until its caller finishes the visible handoff. */
  holdLanding(path: string): () => void;
  releaseLanding(path: string): void;
  withLandingHold<T>(path: string, work: () => Promise<T>): Promise<T>;
  /** External pin refs changed without publishing the app store. */
  notifyPins(): void;
  /** A socket or environment ended; none of its observations survive. */
  clear(): void;
}

/** Reconcile the socket's observed default holds against canonical UI ownership. */
export function useTranscriptMembership(deps: TranscriptMembershipDeps): TranscriptMembership {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const held = useRef(new Set<string>());
  const landingTokens = useRef(new Map<string, Set<symbol>>());
  const attempted = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reconcile = useCallback(() => {
    const current = depsRef.current;
    if (current.connection !== "open") return;
    const paths = releasableTranscriptPaths(
      current.read(),
      held.current,
      new Set(landingTokens.current.keys()),
      attempted.current,
      current.environment,
    );
    for (const path of paths) {
      // One attempt per observed hold. HostClient removes a successfully sent
      // release synchronously; a pre-send refusal remains visible but never
      // becomes a retry on every store publication.
      attempted.current.add(path);
      void current.detach(path).catch(current.onError);
    }
  }, []);

  const schedule = useCallback(() => {
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      reconcile();
    }, 0);
  }, [reconcile]);

  const clear = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    held.current.clear();
    landingTokens.current.clear();
    attempted.current.clear();
  }, []);

  const observer = useMemo<TranscriptHoldObserver>(() => ({
    hold(path, owner) {
      if (owner !== undefined) return;
      held.current.add(path);
      attempted.current.delete(path);
      // The caller of an admitted new/fork response must get the same turn to
      // establish its landing hold before reconciliation runs.
      schedule();
    },
    release(path, owner) {
      if (owner !== undefined) return;
      held.current.delete(path);
      attempted.current.delete(path);
    },
  }), [schedule]);

  const holdLanding = useCallback((path: string): (() => void) => {
    const token = Symbol(path);
    const tokens = landingTokens.current.get(path) ?? new Set<symbol>();
    tokens.add(token);
    landingTokens.current.set(path, tokens);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = landingTokens.current.get(path);
      if (!current?.delete(token)) return;
      if (current.size === 0) landingTokens.current.delete(path);
      reconcile();
    };
  }, [reconcile]);

  const releaseLanding = useCallback((path: string): void => {
    if (!landingTokens.current.delete(path)) return;
    reconcile();
  }, [reconcile]);

  const withLandingHold = useCallback(async <T,>(path: string, work: () => Promise<T>): Promise<T> => {
    const release = holdLanding(path);
    try {
      return await work();
    } finally {
      release();
    }
  }, [holdLanding]);

  useEffect(() => {
    if (deps.connection !== "open") {
      clear();
      return;
    }
    reconcile();
    return deps.subscribe(reconcile);
  }, [clear, deps.connection, deps.subscribe, reconcile]);

  useEffect(() => clear, [clear]);

  return useMemo(() => ({ observer, holdLanding, releaseLanding, withLandingHold, notifyPins: reconcile, clear }),
    [clear, holdLanding, observer, reconcile, releaseLanding, withLandingHold]);
}
