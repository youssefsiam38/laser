/**
 * What an open API request inspector is showing, and what a later read is
 * allowed to do to it (M16-T35).
 *
 * A capture is an immutable record: id `n` is the same request every time it
 * is read. So reading again — the Refresh control, or the dialog asking once
 * more — is additive. Rows already on screen keep the object they have (the
 * body, its payload fetch and its provenance spans all hang off that
 * identity), the capture a person chose stays chosen, and a read that finds
 * nothing leaves what is being read alone. Only a genuinely new capture is new.
 */
import type { LogEntry } from "@lasercode/protocol";

export interface ShownCaptures {
  entries: LogEntry[];
  selected?: number | undefined;
}

/** Nothing read yet: the state the inspector opens in. */
export const NO_SHOWN_CAPTURES: ShownCaptures = { entries: [] };

export function adoptCaptures(current: ShownCaptures, incoming: readonly LogEntry[]): ShownCaptures {
  if (incoming.length === 0) return current;
  const entries = incoming.map((next) => current.entries.find((row) => row.id === next.id) ?? next);
  const selected = entries.some((row) => row.id === current.selected) ? current.selected : entries[0]?.id;
  const unchanged =
    selected === current.selected &&
    entries.length === current.entries.length &&
    entries.every((row, index) => row === current.entries[index]);
  return unchanged ? current : { entries, selected };
}
