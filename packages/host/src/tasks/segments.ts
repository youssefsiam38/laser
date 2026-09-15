/**
 * The names a command's log segments have (RP-6).
 *
 * A segment is `<id>.<first stream byte>.log`, written once and only appended
 * to. The host reads a window by listing the directory the task named and
 * taking each file's offset from its own name: a record that a rotation has
 * just made stale can therefore only read a correctly labelled segment or find
 * none at all. It can never label bytes from one file with the offsets of
 * another, which is what a record-carried offset allowed.
 *
 * This is the reader's half of `packages/pi-extension/src/modules/task-log.ts`
 * — deliberately duplicated rather than imported, because nothing above the
 * worker imports the companion extension (AGENTS.md invariant 1).
 */

/** The stream offset a segment file's name declares, or `undefined`. */
export function segmentOffset(id: string, name: string): number | undefined {
  if (!name.startsWith(`${id}.`) || !name.endsWith(".log")) return undefined;
  const middle = name.slice(id.length + 1, -".log".length);
  if (!/^\d+$/.test(middle)) return undefined;
  const from = Number(middle);
  return Number.isSafeInteger(from) ? from : undefined;
}
