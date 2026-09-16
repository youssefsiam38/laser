"use client";

import { runtimeRecoveryCopy, type WorkerInfo, type WorkerMode } from "@lasercode/protocol";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function WorkerRecoveryNotice({
  worker,
  onRestart,
  className,
}: {
  worker: WorkerInfo | undefined;
  onRestart: (mode?: WorkerMode) => void;
  className?: string;
}) {
  if (worker?.status !== "crashed") return null;
  const copy = runtimeRecoveryCopy({ ...worker, mode: worker.mode ?? "normal" });
  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)}>
      <ErrorState
        className="w-full min-w-0 flex-1 basis-full sm:basis-auto"
        title={copy.title}
        detail={copy.detail}
        onRetry={() => onRestart()}
        retryLabel="Try again"
      />
      {worker.mode === "safe"
        ? <Button variant="outline" className="pointer-coarse:min-h-11" onClick={() => onRestart("normal")}>Try normal mode</Button>
        : <Button variant="outline" className="pointer-coarse:min-h-11" onClick={() => onRestart("safe")}>Start in safe mode</Button>}
    </div>
  );
}
