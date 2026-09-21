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
 * and a secondary surface over it), so each holder names itself with an owner label
 * and the session leaves this connection's delivery when the last of them lets
 * go. Reopening adds it again, and the reopen reconciles from `fromSeq` — the
 * worker replays what was missed, and `replayFrom` tells a client whose gap is
 * older than the buffer to resync instead of silently missing updates. So a
 * dropped update is re-delivered rather than lost.
 *
 * Three invariants this must not break:
 *
 * - **Only transcript updates are scoped.** Questions, attention, task and run
 *   events, worker status and every other small notification stay global,
 *   because they are how a person learns that something they are *not* looking
 *   at needs them.
 * - **A connection hears a transcript only after it asks for it.** Delivery is
 *   scoped from the first byte: a socket that has loaded nothing is shown
 *   nothing, so a new connection can never be handed every conversation in
 *   flight on the machine, and there is no opt-in flag to forget to send.
 * - **Nothing here is authorization.** An owner is a local label a connection
 *   chose for its own surfaces; the method's own scope and reach have already
 *   been decided by the time anything reaches this class. The bounds below
 *   exist so a client cannot grow the host's memory, not to protect data — and
 *   a load over them is refused in a sentence rather than quietly half-served.
 */

/** The default owner: the connection's own main view. */
export const DEFAULT_DELIVERY_OWNER = "view";
/** Sessions one connection may hold at once, held and in flight together. */
export const MEMBERSHIP_PATHS_MAX = 256;
/** Surfaces of one connection that may hold the same session. */
export const MEMBERSHIP_OWNERS_PER_PATH_MAX = 8;

/** The refusal a person reads when a client asks to hold more than it may. */
export const MEMBERSHIP_REFUSAL =
  "This connection is already following as many conversations as it may at once. Close one before opening another.";

/** What the rest of the host may ask about membership. Read-only by design. */
export interface SessionMembershipView {
  /**
   * Connection-and-scope owners holding this path right now, **in-flight
   * attaches included**: a session somebody is in the middle of opening is
   * pinned, not free to unload (RP-4 consumes this as one of its guards).
   */
  holders(path: string): number;
  /** Every path this connection is holding. Iterated, never materialised. */
  paths(): IterableIterator<string>;
  /** Whether this connection holds this exact path. */
  holdsPath(path: string): boolean;
  /** Retention evidence: paths held and owners holding them. */
  counts(): { paths: number; owners: number };
}

/**
 * One surface's hold on one session, admitted or still loading.
 *
 * `generation` is what makes the detach/load race decidable without keeping a
 * record per request: a detach removes the entry, so a load that completes
 * afterwards finds its generation gone and does not admit, while a load begun
 * *after* the detach is a newer generation that the older detach can no longer
 * cancel. `inFlight` counts concurrent loads of the same surface, which are
 * one hold however many there are.
 */
interface Hold {
  generation: number;
  inFlight: number;
  admitted: boolean;
}

export class TranscriptDelivery {
  /** path → owner → hold. Held and in-flight surfaces live in one bounded map. */
  private readonly members = new Map<string, Map<string, Hold>>();
  private generation = 0;
  private reservations = 0;

  begin(raw: unknown): { refusal?: string; finish: (response?: JsonRpcResponse) => void } {
    let request;
    try { request = parseClientRequest(raw); } catch { return { finish: () => {} }; }
    if (request.method === "session/load") {
      const { path } = request.params;
      const owner = request.params.owner ?? DEFAULT_DELIVERY_OWNER;
      const hold = this.claim(path, owner);
      // Refused *before* the router runs, so a load this connection cannot
      // follow never becomes work in a worker either.
      if (!hold) return { refusal: MEMBERSHIP_REFUSAL, finish: () => {} };
      const generation = hold.generation;
      return {
        finish: (response) => {
          const current = this.members.get(path)?.get(owner);
          // A detach removed this hold, or a claim after that detach replaced
          // it with a new generation: either way this reply is about something
          // that no longer exists and must not touch what does.
          if (!current || current.generation !== generation) return;
          current.inFlight = Math.max(0, current.inFlight - 1);
          // One success admits the surface, whatever its siblings answered; a
          // failure only releases it when nothing succeeded and nothing else
          // is still trying.
          if (response && !response.error) current.admitted = true;
          else if (!current.admitted && current.inFlight === 0) this.release(path, owner);
        },
      };
    }
    if (request.method === "pi/session/detach") {
      const { path } = request.params;
      // Released at once, not at the response: the response carries nothing,
      // and a client that has stopped showing a session has stopped showing it.
      // This also cancels a load of the same surface that is still in flight.
      this.release(path, request.params.owner ?? DEFAULT_DELIVERY_OWNER);
      return { finish: () => {} };
    }
    if (request.method === "session/new" || request.method === "pi/session/fork") {
      // The worker chooses the destination path, so the slot is reserved
      // *before* the request runs and converted to that path when it answers.
      // There is no global window in which everything is delivered: a session
      // this connection has never named stays filtered, and the response's own
      // state is what the client starts from.
      if (this.members.size + this.reservations >= MEMBERSHIP_PATHS_MAX) {
        return { refusal: MEMBERSHIP_REFUSAL, finish: () => {} };
      }
      this.reservations += 1;
      let settled = false;
      return {
        finish: (response) => {
          if (settled) return;
          settled = true;
          this.reservations -= 1;
          const path = (response?.result as { state?: { path?: string } } | undefined)?.state?.path;
          if (!response || response.error || !path) return;
          const hold = this.claim(path, DEFAULT_DELIVERY_OWNER);
          // The slot was reserved for exactly this, so it is there; admitted
          // at once, because the session exists and this connection made it.
          if (!hold) return;
          hold.inFlight = Math.max(0, hold.inFlight - 1);
          hold.admitted = true;
        },
      };
    }
    return { finish: () => {} };
  }

  accepts(notification: JsonRpcNotification): boolean {
    if (notification.method !== "session/update") return true;
    const path = (notification.params as SessionUpdateParams).sessionPath;
    return this.members.has(path);
  }

  /**
   * Surfaces holding this path, **including ones whose load is still in
   * flight**.
   *
   * An attach that has been asked for but not yet answered is a hold: the
   * worker it needs must not be retired between the request and its reply, and
   * a client that is opening a session is as much a reason to keep it as one
   * that has opened it. Admission decides *delivery*; this decides *pinning*.
   */
  holders(path: string): number {
    return this.members.get(path)?.size ?? 0;
  }

  /** Of those, the ones already admitted to delivery. Evidence, not a guard. */
  admittedHolders(path: string): number {
    let held = 0;
    for (const hold of this.members.get(path)?.values() ?? []) if (hold.admitted) held += 1;
    return held;
  }

  /** Every path this connection is holding, without building a list to do it. */
  paths(): IterableIterator<string> {
    return this.members.keys();
  }

  /** Whether this connection holds this exact path. O(1). */
  holdsPath(path: string): boolean {
    return this.members.has(path);
  }

  counts(): { paths: number; owners: number } {
    let owners = 0;
    for (const byOwner of this.members.values()) owners += byOwner.size;
    return { paths: this.members.size, owners };
  }

  /**
   * Take (or renew) one surface's hold, or refuse it.
   *
   * Both bounds count held and in-flight surfaces together, so a client that
   * opens a thousand concurrent loads under invented labels cannot grow this
   * past 256 × 8 entries.
   */
  private claim(path: string, owner: string): Hold | undefined {
    const byOwner = this.members.get(path);
    if (!byOwner) {
      if (this.members.size + this.reservations >= MEMBERSHIP_PATHS_MAX) return undefined;
      const hold: Hold = { generation: ++this.generation, inFlight: 1, admitted: false };
      this.members.set(path, new Map([[owner, hold]]));
      return hold;
    }
    const existing = byOwner.get(owner);
    if (existing) {
      // Duplicate concurrent loads of one surface are one hold and **share its
      // generation**: each of them decrements when it finishes, so a first
      // reply cannot orphan the count a second reply is still holding. Moving
      // the generation here used to do exactly that — the first load saw a
      // mismatch, never decremented, and a later failure could leave a hold
      // pinned for ever or throw away the only success.
      existing.inFlight += 1;
      return existing;
    }
    if (byOwner.size >= MEMBERSHIP_OWNERS_PER_PATH_MAX) return undefined;
    const hold: Hold = { generation: ++this.generation, inFlight: 1, admitted: false };
    byOwner.set(owner, hold);
    return hold;
  }

  private release(path: string, owner: string): void {
    const byOwner = this.members.get(path);
    if (!byOwner) return;
    byOwner.delete(owner);
    if (byOwner.size === 0) this.members.delete(path);
  }
}
