import { createContext, useContext, type ReactNode } from "react";

/**
 * Mount points other lanes fill inside the thread column without owning its
 * files. `statusLine` is the trailing slot of the status line above the
 * composer — where the fleet pill ("3 running · 1 needs you") goes (D-20 §5).
 * Pass it as `<Thread statusSlot={…} />` or wrap with `<ThreadSlotsProvider>`.
 */
export interface ThreadSlots {
  readonly statusLine?: ReactNode;
}

const ThreadSlotsContext = createContext<ThreadSlots>({});

export function ThreadSlotsProvider({ slots, children }: { slots: ThreadSlots; children: ReactNode }) {
  return <ThreadSlotsContext.Provider value={slots}>{children}</ThreadSlotsContext.Provider>;
}

export function useThreadSlots(): ThreadSlots {
  return useContext(ThreadSlotsContext);
}
