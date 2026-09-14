import { parseClientRequest, type JsonRpcNotification, type JsonRpcResponse, type SessionUpdateParams } from "@lasercode/protocol";

/**
 * Who, on one connection, is holding a session's transcript (RP-6).
 *
 * This used to be a set that only ever grew: a client that had loaded a
 * session kept receiving every `session/update` for it until the socket
 * closed, and `pi/session/detach` — the thing a client sends when it stops
 * showing a session — was ignored here on purpose. One window's worth of
 * browsing therefore meant a permanent subscription to every conversation it
 * had touched.
 *
 * It is now reference-counted by **connection and scope**. One connection can
 * be showing the same session in more than one place (the session's own view
 * and a Beam bubble over it), so each holder names itself with an owner label
 * and the session leaves this connection's delivery when the last of them lets
 * go. Reopening adds it again, and the reopen reconciles from `fromSeq` — the
 * worker replays what was missed, and `replayFrom` tells a client whose gap is
 * older than the buffer to resync instead of silently missing updates. So a
 * dropped update is re-delivered rather than lost.
 *
 * Two invariants this must not break:
 *
 * - **Only transcript updates are scoped.** Questions, attention, task and run
 *   events, worker status and every other small notification stay global,
 *   because they are how a person learns that something they are *not* looking
 *   at needs them.
 * - **Nothing here is authorization.** An owner is a local label a connection
 *   chose for its own surfaces; the method's own scope and reach have already
 *   been decided by the time anything reaches this class. Bounds below exist
 *   so a client cannot grow the host's memory, not to protect data.
 */

/** The default owner: the connection's own main view. */
export const DEFAULT_DELIVERY_OWNER = "view";
/** Sessions one connection may hold at once. */
export const MEMBERSHIP_PATHS_MAX = 256;
/** Surfaces of one connection that may hold the same session. */
export const MEMBERSHIP_OWNERS_PER_PATH_MAX = 8;

/** What the rest of the host may ask about membership. Read-only by design. */
export interface SessionMembershipView {
  /** Connection-and-scope owners holding this path right now. */
  holders(path: string): number;
  /** Every path this connection is holding. */
  paths(): string[];
  /** Retention evidence: paths held and owners holding them. */
  counts(): { paths: number; owners: number };
}

interface Admission {
  /** Increases per admission; a detach releases the generation it saw. */
  generation: number;
}

export class TranscriptDelivery implements SessionMembershipView {
  private selective = false;
  /** path → owner → the admission in force. */
  private readonly members = new Map<string, Map<string, Admission>>();
  /** `path\0owner` → generations of loads in flight, in order. */
  private readonly loading = new Map<string, number[]>();
  private creating = 0;
  private generation = 0;

  begin(raw: unknown): (response?: JsonRpcResponse) => void {
    let request;
    try { request = parseClientRequest(raw); } catch { return () => {}; }
    if (request.method === "session/load") {
      const { path, transcript } = request.params;
      const owner = request.params.owner ?? DEFAULT_DELIVERY_OWNER;
      if (transcript === "loaded") this.selective = true;
      if (!this.admissible(path, owner)) return () => {};
      // The load is admitted while it runs so replay is never dropped, and it
      // carries its own generation: a detach that arrives in the middle
      // releases *this* load, and a load begun after that detach is a newer
      // generation which the older detach can no longer cancel.
      const generation = ++this.generation;
      this.beginLoading(path, owner, generation);
      return response => {
        const stillWanted = this.endLoading(path, owner, generation);
        if (response && !response.error && stillWanted) this.admit(path, owner, generation);
      };
    }
    if (request.method === "pi/session/detach") {
      const { path } = request.params;
      const owner = request.params.owner ?? DEFAULT_DELIVERY_OWNER;
      // Released at once, not at the response: the response carries nothing,
      // and a client that has stopped showing a session has stopped showing it.
      this.release(path, owner);
      return () => {};
    }
    if (request.method === "session/new" || request.method === "pi/session/fork") {
      // The worker chooses the destination path. Admit its first events before
      // the response tells us which cache owns them, then narrow again.
      this.creating++;
      return response => {
        this.creating--;
        const path = (response?.result as { state?: { path?: string } } | undefined)?.state?.path;
        if (response && !response.error && path) this.admit(path, DEFAULT_DELIVERY_OWNER, ++this.generation);
      };
    }
    return () => {};
  }

  accepts(notification: JsonRpcNotification): boolean {
    if (!this.selective || this.creating || notification.method !== "session/update") return true;
    const path = (notification.params as SessionUpdateParams).sessionPath;
    return this.members.has(path) || this.isLoading(path);
  }

  holders(path: string): number {
    return this.members.get(path)?.size ?? 0;
  }

  paths(): string[] {
    return [...this.members.keys()];
  }

  counts(): { paths: number; owners: number } {
    let owners = 0;
    for (const byOwner of this.members.values()) owners += byOwner.size;
    return { paths: this.members.size, owners };
  }

  /**
   * Whether this connection may hold one more. A client that invents owner
   * labels cannot grow this beyond the two bounds; over them the load is
   * simply not admitted here, which costs that client its own live updates for
   * that surface and costs the host nothing.
   */
  private admissible(path: string, owner: string): boolean {
    const byOwner = this.members.get(path);
    if (byOwner) return byOwner.has(owner) || byOwner.size < MEMBERSHIP_OWNERS_PER_PATH_MAX;
    return this.members.size < MEMBERSHIP_PATHS_MAX;
  }

  private admit(path: string, owner: string, generation: number): void {
    if (!this.admissible(path, owner)) return;
    let byOwner = this.members.get(path);
    if (!byOwner) {
      byOwner = new Map();
      this.members.set(path, byOwner);
    }
    // Duplicate concurrent loads by the same owner are one hold, not two.
    byOwner.set(owner, { generation });
  }

  private release(path: string, owner: string): void {
    const byOwner = this.members.get(path);
    if (byOwner) {
      byOwner.delete(owner);
      if (byOwner.size === 0) this.members.delete(path);
    }
    // A load of this exact owner that is still in flight is what the detach
    // is about: cancelling it here is what stops its completion from bringing
    // a released owner back to life.
    this.loading.delete(this.key(path, owner));
  }

  private key(path: string, owner: string): string {
    return `${path}\u0000${owner}`;
  }

  private beginLoading(path: string, owner: string, generation: number): void {
    const key = this.key(path, owner);
    const generations = this.loading.get(key);
    if (generations) generations.push(generation);
    else this.loading.set(key, [generation]);
  }

  /** Remove this load; false when a detach cancelled it while it ran. */
  private endLoading(path: string, owner: string, generation: number): boolean {
    const key = this.key(path, owner);
    const generations = this.loading.get(key);
    if (!generations) return false;
    const at = generations.indexOf(generation);
    if (at < 0) return false;
    generations.splice(at, 1);
    if (generations.length === 0) this.loading.delete(key);
    return true;
  }

  private isLoading(path: string): boolean {
    const prefix = `${path}\u0000`;
    for (const key of this.loading.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }
}
