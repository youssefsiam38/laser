/**
 * The control inbox (M3-T4): steer, stop and interrupt a background run from
 * outside the Pi process that launched it.
 *
 * pi-subagents 0.65 has no sockets and no IPC. The detached runner watches
 * `<asyncDir>/control/` and acts on files it finds there, which is why a run
 * started from a terminal is still controllable from piorbit — and why this
 * lives in the host rather than in the companion extension.
 *
 * Every byte below matches `pi-subagents/src/runs/background/control-channel.ts`
 * as shipped in 0.65.0 (read 2026-09-05), including the file names, which the
 * runner sorts by:
 *
 *   control/steer-requests/<ts padded to 13>-<base64url(id)>.json
 *   control/stop-requests/<ts padded to 13>-<uuid>.json
 *   control/interrupt.json
 *   control/steer-inbox-closed.json      written by the runner; steering is over
 *
 * Writes are atomic the same way the runner's are (temp file in the same
 * directory, then rename), so a runner reading mid-write never sees half a
 * request. Resume is deliberately absent: it is only reachable through the
 * owning Pi session's bus (findings.md), so it is the module's job, not this
 * file's.
 */
import { WIRE_NAMESPACE } from "@lasercode/protocol";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** pi-subagents' own limit; a longer message is refused by the runner's validator. */
export const MAX_STEER_MESSAGE_BYTES = 128 * 1024;

/** How piorbit names itself in a control request, so `subagent status` shows where it came from. */
/**
 * The `source` stamped on a control message pi-subagents reads back.
 *
 * The wire namespace, not the product name: it is written into files another
 * process parses, so a rename must not make a run started before it unreadable.
 */
export const CONTROL_SOURCE: string = WIRE_NAMESPACE;

export class ControlError extends Error {
  override readonly name = "ControlError";
  constructor(message: string) {
    super(message);
  }
}

export const controlDir = (asyncDir: string): string => join(asyncDir, "control");
export const steerRequestsDir = (asyncDir: string): string => join(controlDir(asyncDir), "steer-requests");
export const stopRequestsDir = (asyncDir: string): string => join(controlDir(asyncDir), "stop-requests");
export const interruptPath = (asyncDir: string): string => join(controlDir(asyncDir), "interrupt.json");
export const steerClosedPath = (asyncDir: string): string => join(controlDir(asyncDir), "steer-inbox-closed.json");

/** The runner stops reading steers once it writes this. Checked before and after a write. */
export function steeringClosed(asyncDir: string): boolean {
  return existsSync(steerClosedPath(asyncDir));
}

const pad13 = (ts: number): string => String(ts).padStart(13, "0");

/** `<ts>-<base64url(id)>.json`, exactly as the runner's sorter expects. */
export function steerFileName(id: string, ts: number): string {
  return `${pad13(ts)}-${Buffer.from(id).toString("base64url")}.json`;
}

export function stopFileName(ts: number, uuid: string): string {
  return `${pad13(ts)}-${uuid}.json`;
}

function writeAtomicJson(filePath: string, payload: object): void {
  // `dirname`/`basename`, never a split on a literal slash: every path that
  // reaches here was built with `join`, which uses a backslash on win32, and a
  // hand-rolled split would put the temp file and the rename target somewhere
  // that is not the inbox at all.
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  let failed: unknown;
  try {
    writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: "utf-8" });
    renameSync(temp, filePath);
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch (cleanup) {
      if (failed === undefined) throw cleanup;
    }
  }
}

export interface SteerInput {
  asyncDir: string;
  message: string;
  /** Which child of a multi-step run. Omit for the run as a whole. */
  targetIndex?: number;
  now?: () => number;
  newId?: () => string;
}

/**
 * Drop a steer into the inbox. Refuses rather than writing when the runner has
 * closed steering, because a request written after the close is silently
 * dropped and the person would be told their message landed.
 */
export function requestSteer(input: SteerInput): string {
  const message = input.message.trim();
  if (!message) throw new ControlError("A steer needs something to say.");
  if (Buffer.byteLength(message, "utf8") > MAX_STEER_MESSAGE_BYTES) {
    throw new ControlError("That steer is longer than pi-subagents accepts (128 KB). Send the short version.");
  }
  assertIndex(input.targetIndex);
  if (steeringClosed(input.asyncDir)) {
    throw new ControlError("This run has stopped accepting steers — it is wrapping up. Wait for its result.");
  }
  const ts = input.now?.() ?? Date.now();
  const id = input.newId?.() ?? randomUUID();
  const path = join(steerRequestsDir(input.asyncDir), steerFileName(id, ts));
  writeAtomicJson(path, {
    type: "steer",
    id,
    ts,
    message,
    ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
    source: CONTROL_SOURCE,
  });
  // The runner may have closed the inbox between the check and the rename; it
  // would never read this file, so take it back rather than lie about delivery.
  if (steeringClosed(input.asyncDir)) {
    rmSync(path, { force: true });
    throw new ControlError("This run stopped accepting steers just as the message was written. Nothing was sent.");
  }
  return path;
}

export interface StopInput {
  asyncDir: string;
  /** Which child of a multi-step run. Omit to stop the whole run. */
  targetIndex?: number;
  /** pi-subagents' stable child identity, when the status file gave us one. */
  childId?: string;
  now?: () => number;
  newId?: () => string;
}

export function requestStop(input: StopInput): string {
  assertIndex(input.targetIndex);
  if (input.childId !== undefined && (input.childId.trim() === "" || input.childId.length > 256 || /[\r\n]/.test(input.childId))) {
    throw new ControlError("That child id is not one pi-subagents would accept.");
  }
  const ts = input.now?.() ?? Date.now();
  const path = join(stopRequestsDir(input.asyncDir), stopFileName(ts, input.newId?.() ?? randomUUID()));
  writeAtomicJson(path, {
    type: "stop",
    ts,
    source: CONTROL_SOURCE,
    ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
    ...(input.childId !== undefined ? { childId: input.childId } : {}),
  });
  return path;
}

export function requestInterrupt(input: { asyncDir: string; reason?: string; now?: () => number }): string {
  const path = interruptPath(input.asyncDir);
  writeAtomicJson(path, {
    type: "interrupt",
    ts: input.now?.() ?? Date.now(),
    source: CONTROL_SOURCE,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  return path;
}

function assertIndex(index: number | undefined): void {
  if (index === undefined) return;
  if (!Number.isInteger(index) || index < 0 || index > 1_000_000) {
    throw new ControlError("That child index is out of range.");
  }
}
