/**
 * Reconnect hardening for a socket the phone may have silently killed.
 *
 * iOS suspends a backgrounded page and closes its WebSockets on lock,
 * sometimes without ever firing `close` (docs/research/findings.md). To the
 * client the socket still reads `OPEN`; the first sign of trouble would be a
 * request that never answers. So this guard never trusts the socket's own
 * word: whenever the page becomes visible, is restored from the back-forward
 * cache, regains network, or on a slow heartbeat while visible, it *probes*
 * the connection with a cheap host-answered request and forces a fresh socket
 * when the probe does not come back in time. Resuming from the per-session
 * `seq` is the client's own job (`HostClient` re-issues `session/load
 * { fromSeq }` on every open), so no output is lost.
 *
 * Injected clock and client so the timing is unit-tested (test/pwa/reconnect.test.ts).
 */

export type GuardConnectionState = "connecting" | "open" | "closed";

export interface ReconnectableClient {
  readonly connection: GuardConnectionState;
  /** Any cheap request the host answers without a worker. */
  probe(): Promise<unknown>;
  /**
   * Drop the current socket without waiting for its `close`, and open a new
   * one that resumes every tracked session. When the client cannot do that
   * atomically, `close()` + `connect()` is the fallback (see `forceReconnect`).
   */
  reconnect?(reason: string): void;
  close(): void;
  connect(): void;
}

export interface ReconnectGuardOptions {
  /** How long a probe may take before the socket is declared dead. */
  probeTimeoutMs?: number;
  /** Probe cadence while the page is visible; 0 disables the heartbeat. */
  heartbeatMs?: number;
  /** How long `connecting` may last before we stop waiting for the browser. */
  connectingTimeoutMs?: number;
  /** For tests. */
  clock?: Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
  /** For tests and logs: what the guard decided and why. */
  onEvent?: (event: ReconnectGuardEvent) => void;
}

export type ReconnectGuardEvent =
  | { type: "probe"; trigger: string }
  | { type: "probe-ok"; trigger: string }
  | { type: "reconnect"; reason: string };

export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_CONNECTING_TIMEOUT_MS = 12_000;

export interface ReconnectGuard {
  /** Run one probe now (e.g. from a "Retry" control). */
  probe(trigger: string): Promise<void>;
  dispose(): void;
}

export function createReconnectGuard(client: ReconnectableClient, options: ReconnectGuardOptions = {}): ReconnectGuard {
  const clock = options.clock ?? globalThis;
  const probeTimeout = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connectingTimeout = options.connectingTimeoutMs ?? DEFAULT_CONNECTING_TIMEOUT_MS;
  const emit = options.onEvent ?? (() => {});
  let inFlight: Promise<void> | undefined;
  let connectingSince: number | undefined;
  let disposed = false;

  const forceReconnect = (reason: string): void => {
    emit({ type: "reconnect", reason });
    if (client.reconnect) {
      client.reconnect(reason);
      return;
    }
    // Fallback for a client without `reconnect()`: its `close()` waits for the
    // old socket's `close` event to flip state, which a dead iOS socket can
    // delay for seconds, and that late event rejects requests the new socket
    // has already sent. The client needs a real `reconnect()`; this is the
    // best that can be done from outside it.
    client.close();
    client.connect();
  };

  const probe = (trigger: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const state = client.connection;
      if (state === "closed") {
        // The client is in its own backoff; a person just looked at the screen,
        // so skip the wait.
        forceReconnect(`${trigger}: socket closed`);
        return;
      }
      if (state === "connecting") {
        connectingSince ??= Date.now();
        if (Date.now() - connectingSince > connectingTimeout) {
          connectingSince = undefined;
          forceReconnect(`${trigger}: stuck connecting`);
        }
        return;
      }
      connectingSince = undefined;
      emit({ type: "probe", trigger });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = clock.setTimeout(() => resolve("timeout"), probeTimeout);
      });
      try {
        const outcome = await Promise.race([client.probe().then(() => "ok" as const), timeout]);
        if (outcome === "timeout") forceReconnect(`${trigger}: no answer in ${probeTimeout}ms`);
        else emit({ type: "probe-ok", trigger });
      } catch {
        // A rejected probe means the socket already knows it is closed and the
        // client's own reconnect is under way; nothing to force.
      } finally {
        if (timer !== undefined) clock.clearTimeout(timer);
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") void probe("visible");
  };
  const onPageShow = (): void => void probe("pageshow");
  const onOnline = (): void => void probe("online");
  const onFocus = (): void => void probe("focus");

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    if (heartbeatMs > 0) {
      heartbeat = clock.setInterval(() => {
        if (document.visibilityState === "visible") void probe("heartbeat");
      }, heartbeatMs);
    }
  }

  return {
    probe,
    dispose() {
      disposed = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pageshow", onPageShow);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("focus", onFocus);
      }
      if (heartbeat !== undefined) clock.clearInterval(heartbeat);
    },
  };
}
