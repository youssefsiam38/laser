/**
 * What the project-work store refuses, and how it says so (M21-T2).
 *
 * Every refusal here is written for a person: what went wrong, and what to do
 * next. The router turns each one into the JSON-RPC error its callers expect
 * (M21-T3); nothing in this file knows about JSON-RPC.
 *
 * The fields are assigned in the body rather than declared as constructor
 * parameters so this module runs unchanged wherever plain type stripping is
 * the only transform — the crash fixture runs it that way.
 */
import type { ProjectWorkRef, StaleUpstreamRef } from "@lasercode/protocol";

/**
 * What a refusal carries besides its sentence.
 *
 * Only one shape so far: the upstream revision that went stale, so a client
 * can offer "reconcile PLAN-3" without reading the graph again (M21-T15). The
 * sentence always names the key; this is the identity behind it.
 */
export type ProjectWorkRefusalData = { refused: "stale_upstream"; upstream: StaleUpstreamRef };

/** A write that named a revision that is no longer current. Never an overwrite. */
export class ProjectWorkConflictError extends Error {
  override readonly name = "ProjectWorkConflictError";
  readonly current: ProjectWorkRef;
  readonly expectedRevisionId: string;
  constructor(current: ProjectWorkRef, expectedRevisionId: string) {
    super(
      `${current.key} changed while you were working on it. Look at the difference, then keep your version as a new revision or start from the current one.`,
    );
    this.current = current;
    this.expectedRevisionId = expectedRevisionId;
  }
}

/**
 * Which ceiling a durable write reached.
 *
 * A count is never reported as a number of bytes: `records` and `entities`
 * carry their own used/limit pair, and `usedBytes`/`limitBytes` keep saying
 * what they have always said — the real byte usage and the real byte cap.
 */
export type ProjectWorkQuotaMeasure = "bytes" | "records" | "entities";

/** The count ceiling a refusal reached, when it was not the byte one. */
export interface ProjectWorkQuotaCount {
  measure: "records" | "entities";
  used: number;
  limit: number;
}

/** The durable budget is full. Canonical work is never evicted to make room. */
export class ProjectWorkQuotaError extends Error {
  override readonly name = "ProjectWorkQuotaError";
  readonly scope: "project" | "global";
  /** Which ceiling was reached. Bytes unless a count ceiling was given. */
  readonly measure: ProjectWorkQuotaMeasure;
  readonly usedBytes: number;
  readonly limitBytes: number;
  /** Set when the refusal was a count, so no caller has to read it as bytes. */
  readonly usedCount: number | undefined;
  readonly limitCount: number | undefined;
  readonly recovery: string;
  constructor(scope: "project" | "global", usedBytes: number, limitBytes: number, recovery: string, count?: ProjectWorkQuotaCount) {
    const whose = scope === "project" ? "This project's" : "The app's";
    super(
      count
        ? `${whose} saved project work has reached its limit of ${count.measure === "entities" ? "items" : "saved records"} ` +
          `(${String(count.used)} of ${String(count.limit)}). ${recovery}`
        : `${whose} saved project work has reached its size limit ` +
          `(${Math.round(usedBytes / 1024 / 1024)} MB of ${Math.round(limitBytes / 1024 / 1024)} MB). ${recovery}`,
    );
    this.scope = scope;
    this.measure = count?.measure ?? "bytes";
    this.usedBytes = usedBytes;
    this.limitBytes = limitBytes;
    this.usedCount = count?.used;
    this.limitCount = count?.limit;
    this.recovery = recovery;
  }
}

/** Nothing here by that identity. */
export class ProjectWorkNotFoundError extends Error {
  override readonly name = "ProjectWorkNotFoundError";
}

/** The transition, gate or action is not one this state allows. */
export class ProjectWorkRefusedError extends Error {
  override readonly name = "ProjectWorkRefusedError";
  readonly data: ProjectWorkRefusalData | undefined;
  constructor(message: string, data?: ProjectWorkRefusalData | undefined) {
    super(message);
    this.data = data;
  }
}

/** The store cannot be opened or used at all, and says why. */
export class ProjectWorkUnavailableError extends Error {
  override readonly name = "ProjectWorkUnavailableError";
}
