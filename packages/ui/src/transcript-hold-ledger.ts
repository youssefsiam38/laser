export interface TranscriptHoldObserver {
  hold(path: string, owner: string | undefined): void;
  release(path: string, owner: string | undefined): void;
}

export interface TranscriptHoldLedger {
  hold(path: string, owner: string | undefined): void;
  release(path: string, owner: string | undefined): void;
  clear(): void;
}

/** Socket-scoped membership ledger shared by the real client and its fakes. */
export function createTranscriptHoldLedger(observer: TranscriptHoldObserver): TranscriptHoldLedger {
  const held = new Map<string, Set<string | undefined>>();
  return {
    hold(path, owner) {
      const owners = held.get(path) ?? new Set<string | undefined>();
      owners.add(owner);
      held.set(path, owners);
      observer.hold(path, owner);
    },
    release(path, owner) {
      const owners = held.get(path);
      owners?.delete(owner);
      if (owners?.size === 0) held.delete(path);
      observer.release(path, owner);
    },
    clear() {
      const memberships = [...held].flatMap(([path, owners]) => [...owners].map((owner) => ({ path, owner })));
      held.clear();
      for (const { path, owner } of memberships) observer.release(path, owner);
    },
  };
}
