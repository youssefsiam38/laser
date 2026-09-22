"use client";
/**
 * The embedded workspace (D-355, "Opening and closing").
 *
 * It takes the main area inside the shell — never a browser, a second window
 * or a transcript panel — and borrows the room the fleet and monitor hold
 * while it is open. The conversation underneath is *not* unmounted: scroll,
 * draft, stream and approvals survive, so "← Back to the conversation" is a
 * return and not a reload. Opening is a morph; reduced motion loses the
 * movement and nothing else.
 */
import { ArrowLeft, Inbox, Plus, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { shortCwd } from "@/format";
import { useBreakpoint, useIsWide } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import {
  closeWorkspace,
  openWorkCreate,
  selectWork,
  setWorkspaceTab,
  useProjectWorkById,
  useProjectWorkSnapshot,
  useWorkspaceUi,
  WORKSPACE_TABS,
  type WorkspaceTab,
} from "@/project-work";

import { Board } from "./Board.js";
import { CreateDialog } from "./CreateDialog.js";
import { IdentityNotice } from "./IdentityNotice.js";
import { ImportExportMenu } from "./ImportExportMenu.js";
import { Inspector } from "./Inspector.js";
import { NeedsYou } from "./NeedsYou.js";
import { Recent } from "./Recent.js";
import { WorkBacklog } from "./WorkBacklog.js";
import { WorkDetail } from "./WorkDetail.js";
import { BehindNotice, WorkLoading, WorkPlaceholder } from "./states.js";

const TAB_LABEL: Readonly<Record<WorkspaceTab, string>> = {
  work: "Work",
  board: "Board",
  "needs-you": "Needs you",
  recent: "Recent",
};

export function ProjectWorkspace() {
  const ui = useWorkspaceUi();
  const store = useProjectWorkById(ui.projectId);
  const work = useProjectWorkSnapshot(store);
  const { projects } = useLaserStable();
  const layout = useBreakpoint();
  const wide = useIsWide();
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const projectName = useMemo(() => {
    const cwd = store?.paths()[0] ?? projects.find((path) => path.length > 0);
    return cwd ? shortCwd(cwd) : "This project";
  }, [projects, store]);

  const retry = useCallback(() => void store?.reconcile(), [store]);

  // What the folder this project was opened at says about itself (M21-T20):
  // whether it is a copy of another project's folder, and whether this
  // project's work is being kept hidden after it was removed from the list.
  useEffect(() => {
    void store?.checkIdentity();
  }, [store]);

  // Esc returns to the conversation, the same key that closes every overlay.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog or a sheet inside the workspace answers Esc first.
      if (document.querySelector("[data-slot='dialog-content'],[data-slot='sheet-content']")) return;
      event.preventDefault();
      closeWorkspace();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = ui.selection;
  const detailColumns = layout === "desktop";
  const showDetailOnly = !detailColumns && selected !== undefined;

  return (
    <section
      data-slot="project-workspace"
      aria-label="Project work"
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-bg",
        "animate-in fade-in-0 zoom-in-[0.99] fill-mode-both duration-(--motion-morph) motion-reduce:animate-none",
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
        <Button variant="ghost" size="sm" onClick={() => closeWorkspace()} className="shrink-0">
          <ArrowLeft className="rtl:-scale-x-100" />
          <span className="hidden sm:inline">Back to the conversation</span>
          <span className="sm:hidden">Back</span>
        </Button>
        <span className="eyebrow hidden min-w-0 truncate md:inline">{projectName}</span>
        <nav aria-label="Project work sections" className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-x-auto scrollbar-none">
          {WORKSPACE_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={ui.tab === tab}
              onClick={() => setWorkspaceTab(tab)}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm leading-5 outline-none",
                "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                ui.tab === tab ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              {TAB_LABEL[tab]}
              {tab === "needs-you" && work.attention.needsYou > 0 ? (
                <span className="typed rounded-full bg-[color-mix(in_oklab,var(--attention)_16%,transparent)] px-1.5 text-attention tnum">
                  {work.attention.needsYou}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        {detailColumns && !wide && selected ? (
          <TooltipIconButton
            tooltip={inspectorOpen ? "Hide the inspector" : "Show the inspector"}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            {inspectorOpen ? <PanelRightClose className="rtl:-scale-x-100" /> : <PanelRightOpen className="rtl:-scale-x-100" />}
          </TooltipIconButton>
        ) : null}
        <Button size="sm" onClick={() => openWorkCreate("spec")} className="shrink-0">
          <Plus />
          <span className="hidden sm:inline">Create</span>
        </Button>
        {/* Where this project's work comes from and where it goes (M21-T21). */}
        <ImportExportMenu store={store} />
      </header>

      <BehindNotice offline={work.behind} error={work.error} onRetry={retry} />
      <IdentityNotice store={store} work={work} />

      {work.phase === "loading" && work.items.length === 0 ? (
        <WorkLoading />
      ) : work.phase === "unavailable" ? (
        <WorkPlaceholder
          icon={Inbox}
          title="This project's work could not be read"
          detail={work.error ?? "The host did not answer. Nothing has been lost; try again when the connection is back."}
          action={
            <Button size="sm" variant="outline" onClick={retry}>
              Try again
            </Button>
          }
        />
      ) : ui.tab === "work" ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          {(!showDetailOnly || !selected) && (
            <WorkBacklog
              store={store}
              work={work}
              // With nothing open the backlog has the whole room and reads as
              // a table; beside a detail it is a column of rows. Same list,
              // less of each row — never smaller type (AGENTS.md).
              table={detailColumns && !selected}
              className={cn(detailColumns && selected ? "w-[clamp(18rem,26vw,24rem)] shrink-0 border-e border-line" : "min-w-0 flex-1")}
            />
          )}
          {selected ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              <WorkDetail store={store} work={work} className="min-w-0 flex-1" onBack={() => selectWork(undefined)} compact={!detailColumns} />
              {detailColumns && wide && selected ? (
                <Inspector store={store} work={work} className="w-[clamp(16rem,20vw,20rem)] shrink-0 border-s border-line" />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : ui.tab === "board" ? (
        <Board store={store} work={work} />
      ) : ui.tab === "needs-you" ? (
        <NeedsYou work={work} />
      ) : (
        <Recent work={work} />
      )}

      {/* At a constrained desktop width the inspector is a sheet, not a column. */}
      <Sheet open={inspectorOpen && detailColumns && !wide} onOpenChange={setInspectorOpen}>
        <SheetContent side="right" className="w-[min(88vw,320px)]">
          <SheetTitle className="sr-only">Inspector</SheetTitle>
          <SheetDescription className="sr-only">Links, comments, revisions and gates for the open item.</SheetDescription>
          <Inspector store={store} work={work} className="min-h-0 flex-1" />
        </SheetContent>
      </Sheet>

      <CreateDialog store={store} />
    </section>
  );
}
