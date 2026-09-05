import { Shell } from "@/components/shell/Shell";
import { LaserProvider } from "@/runtime";

/** Root: the host connection + assistant-ui runtime, then the frame. */
export function App() {
  return (
    <LaserProvider>
      <Shell />
    </LaserProvider>
  );
}
