import { LoaderCircle } from "lucide-react";
import { StatusDot, type Status } from "@/components/status";

/** Navigation stays quiet at rest; only the session that needs attention speaks. */
export function SessionActivity({ status }: { status: Status }) {
  if (status === "idle") return null;
  if (status === "working") {
    return <LoaderCircle role="img" aria-label="Working" data-slot="session-working" className="size-3.5 shrink-0 text-ink-2 motion-safe:animate-sweep" />;
  }
  return <StatusDot status={status} size="sm" />;
}
