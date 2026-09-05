"use client";
/**
 * The workbench frame: a full-height panel that takes over everything right of
 * the project rail. Header carries the two screens and the project the screen
 * is about; the body is the screen itself.
 */
import { Suspense, lazy } from "react";
import { FileClock, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable, usePiorbitView } from "@/runtime";

import { useWorkbench, type WorkbenchPage } from "./workbench-context.js";

// Both screens are heavy and rarely the first thing a person opens, so they
// leave the initial bundle.
const SettingsScreen = lazy(() =>
  import("@/components/settings/SettingsScreen.js").then((m) => ({ default: m.SettingsScreen })),
);
const LogsScreen = lazy(() => import("@/components/logs/LogsScreen.js").then((m) => ({ default: m.LogsScreen })));

const TABS: Array<{ id: WorkbenchPage; label: string; icon: typeof SlidersHorizontal }> = [
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
  { id: "logs", label: "Logs", icon: FileClock },
];

export function Workbench() {
  const { page, open, close } = useWorkbench();
  const { currentProject } = usePiorbitStable();
  const view = usePiorbitView();
  const cwd = currentProject ?? view?.state.cwd;

  if (!page) return null;

  return (
    <section
      aria-label={page === "settings" ? "Settings" : "Logs"}
      className="absolute inset-0 z-30 flex min-w-0 flex-col bg-bg"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 px-2 pt-[env(safe-area-inset-top)] hairline-b">
        <nav className="flex items-center gap-0.5" aria-label="Workbench screens">
          {TABS.map((tab) => (
            <Button
              key={tab.id}
              variant="ghost"
              size="sm"
              onClick={() => open(tab.id)}
              aria-current={page === tab.id ? "page" : undefined}
              className={cn("gap-1.5", page === tab.id && "bg-surface-2 text-ink")}
            >
              <tab.icon />
              {tab.label}
            </Button>
          ))}
        </nav>
        {cwd && (
          <span className="ms-2 min-w-0 truncate font-mono text-xs text-ink-3" title={cwd}>
            {shortCwd(cwd)}
          </span>
        )}
        <div className="ms-auto flex items-center gap-2">
          <Kbd className="hidden sm:inline-flex">Esc</Kbd>
          {/* One label for everyone: `TooltipIconButton` derives the
              accessible name from the tooltip, so a screen reader and a
              sighted user cannot be told two different things. */}
          <TooltipIconButton tooltip="Back to the session" onClick={close}>
            <X />
          </TooltipIconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <Suspense fallback={<ScreenSkeleton />}>
          {page === "settings" ? <SettingsScreen cwd={cwd} /> : <LogsScreen cwd={cwd} />}
        </Suspense>
      </div>
    </section>
  );
}

function ScreenSkeleton() {
  return (
    <div className="flex h-full gap-4 p-4">
      <div className="hidden w-52 shrink-0 flex-col gap-2 md:flex">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
