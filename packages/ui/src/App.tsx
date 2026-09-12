import { Direction } from "radix-ui";
import { useDirection } from "@/hooks/use-direction";
import { Shell } from "@/components/shell/Shell";
import { LaserProvider } from "@/runtime";
import { LinkDestination } from "@/components/shell/LinkDestination";

/** Root: the host connection + assistant-ui runtime, then the frame. */
export function App() {
  const direction = useDirection();
  return (
    <Direction.Provider dir={direction}>
      <LaserProvider>
        <Shell />
        <LinkDestination />
      </LaserProvider>
    </Direction.Provider>
  );
}
