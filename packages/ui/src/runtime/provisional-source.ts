/**
 * Where an immediate paint reads from (RP-11).
 *
 * The app reads the bounded device cache (RP-10) and nothing else. This module
 * exists so that seam is one named thing rather than a direct import at the
 * call site: a test stands a record in front of the same code path the app
 * runs, the way `installViewTailSink` already lets RP-10 take what RP-5
 * releases. It is installed once, at the top of the process, and the app never
 * installs anything but the real cache.
 */
import { tailCache } from "./tail-cache/index.js";
import type { TailRecord } from "./tail-cache/record.js";

export interface ProvisionalSource {
  /** Synchronous, hot-set only, allocation-free on a hit. */
  peek(target: { sessionId: string }): TailRecord | undefined;
  /** Promote records into the hot set so a later `peek` can hit. Bounded. */
  prime(sessionIds: readonly string[]): Promise<void>;
  /** A record the host has now answered for stops being a candidate. */
  supersede(sessionId: string, revision: string): void;
}

let installed: ProvisionalSource = tailCache;

/** Install a source; the return value is the one it replaced, for restoring it. */
export function installProvisionalSource(source: ProvisionalSource | undefined): ProvisionalSource {
  const previous = installed;
  installed = source ?? tailCache;
  return previous;
}

/** The source in force right now. Read at the moment of the paint. */
export function provisionalSource(): ProvisionalSource {
  return installed;
}
