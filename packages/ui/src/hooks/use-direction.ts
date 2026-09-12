import { useCallback, useSyncExternalStore } from "react";
import { themeStore } from "@/theme/store";
import { logicalArrowKey, resolveDirection, type Direction } from "@/theme/direction";

export function useDirection(): Direction {
  return useSyncExternalStore(themeStore.subscribe, () => resolveDirection(themeStore.getState().textDirection), () => "ltr");
}

/** For custom navigation. Radix menus/tabs use the root Direction.Provider instead. */
export function useLogicalArrowKeys(): (key: string) => string {
  const direction = useDirection();
  return useCallback((key: string) => logicalArrowKey(key, direction), [direction]);
}
