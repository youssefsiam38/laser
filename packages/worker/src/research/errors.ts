/**
 * One refusal shape for everything under `research/`.
 *
 * An adapter, the cache, the budget ledger and the protocol's operation
 * applier all refuse in the tool contract's words — a code for correlation, a
 * sentence written for a person, and the next call that would work. The tools
 * render whichever of them reaches them; nothing has to guess a recovery.
 */
export class ResearchRefused extends Error {
  readonly code: string;
  readonly next: string;
  readonly committed: boolean;
  constructor(code: string, message: string, next: string, committed = false) {
    super(message);
    this.name = "ResearchRefused";
    this.code = code;
    this.next = next;
    this.committed = committed;
  }
}

/** A refusal that knows its own code, sentence and recovery. */
export interface KnownRefusal {
  code: string;
  message: string;
  next: string;
  committed?: boolean;
}

export function isKnownRefusal(value: unknown): value is KnownRefusal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<KnownRefusal>;
  return typeof candidate.code === "string" && typeof candidate.message === "string" && typeof candidate.next === "string";
}
