import { Sparkles } from "lucide-react";

import { useSessionAgent } from "@/agents";
import { cn } from "@/lib/utils";

/**
 * The quiet Beam mark before a session title when the open session is one of
 * Beam's. View styling only — it opens nothing; Beam's one entry point is the
 * spark (`BeamSpark`).
 */
export function BeamSessionMark({ path, className }: { path: string | undefined; className?: string | undefined }) {
  const agent = useSessionAgent(path);
  if (agent?.kind !== "beam") return null;
  return (
    <Sparkles
      role="img"
      aria-label="Beam session"
      data-slot="beam-session-mark"
      className={cn("size-3.5 shrink-0 text-live", className)}
    />
  );
}
