/**
 * `+1 204 −318`: the one way this overlay draws a pair of change counts.
 *
 * Mono at the 12px floor (`typed` carries `tabular-nums`), grouped with a
 * no-break space so four figures never wrap mid-number, and the groups keep
 * their meaning colours — `--ok` for what arrived, `--danger` for what left.
 * Nothing here is centred or boxed: it is a value, and it sits on the ground
 * the row already has.
 */
import { cn } from "@/lib/utils";

import { changeCount } from "./classify.js";

export function ChangeTotals({
  added,
  removed,
  empty = "no changes",
  className,
}: {
  added: number;
  removed: number;
  /** What to say when a scope really changed nothing. */
  empty?: string;
  className?: string | undefined;
}) {
  if (added === 0 && removed === 0) {
    return (
      <span data-slot="changes-totals" className={cn("typed shrink-0 text-ink-3", className)}>
        {empty}
      </span>
    );
  }
  return (
    <span data-slot="changes-totals" className={cn("typed flex shrink-0 items-center gap-1.5", className)}>
      {added > 0 ? <span className="text-ok">+{changeCount(added)}</span> : null}
      {removed > 0 ? <span className="text-danger">−{changeCount(removed)}</span> : null}
    </span>
  );
}
