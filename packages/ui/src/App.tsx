import { Shell } from "@/components/shell/Shell";
import { PiorbitProvider } from "@/runtime";

/** Root: the host connection + assistant-ui runtime, then the frame. */
export function App() {
  return (
    <PiorbitProvider>
      <Shell />
    </PiorbitProvider>
  );
}
