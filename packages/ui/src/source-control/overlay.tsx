import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { collectOpenShadowRoots } from "@/components/thread/find-ranges.js";

import {
  classifyDiffPage,
  fileLineCount,
  listTotals,
  overlayChromeLayout,
  shouldBoundExpansion,
  splitColumnsFit,
} from "./classify.js";
import type { AgentChangesContext, ChangedFile, ChangesList, FileDiffPage } from "./contract.js";
import { clipSelectionToCode } from "./copy.js";
import { getChangesAdapter } from "./data.js";
import { overlayKeyAction } from "./keyboard.js";
import { useOverlayFind } from "./overlay-find.js";
import { ChangesRail } from "./rail.js";
import {
  AgentGoneState,
  DeletedFileState,
  DiffErrorState,
  DiffLoadingState,
  EmptyBodyState,
  LargeFileState,
  NoChangesState,
  OverlayLoadingState,
  PickFileState,
  RepoFailedState,
  UnifiedFallbackNotice,
} from "./states.js";
import {
  addTab,
  closeChanges,
  closeTab,
  cycleFile,
  cycleTab,
  isLargeRevealed,
  revealLargeFile,
  selectTab,
  setChangesScope,
  setDiffStyle,
  setFindOpen,
  setRepoFilter,
  setTreeOpen,
  setUnifiedFallback,
  toggleViewed,
  useChangesUi,
  type OpenFile,
} from "./store.js";
import { ChangesTabStrip } from "./tabs.js";
import { ChangesToolbar } from "./toolbar.js";

const DiffBody = lazy(() => import("./diff-body.js").then((module) => ({ default: module.DiffBody })));

function stepHunk(host: HTMLElement, delta: number): void {
  const roots = collectOpenShadowRoots(host);
  const nodes = roots.flatMap((root) => [...root.querySelectorAll("[data-separator]")]);
  if (!nodes.length) return;
  const viewMid = host.getBoundingClientRect().top + host.clientHeight / 2;
  let index = nodes.findIndex((node) => node.getBoundingClientRect().top >= viewMid - 1);
  if (index < 0) index = delta > 0 ? 0 : nodes.length - 1;
  else if (delta < 0) index = Math.max(0, index - 1);
  else index = Math.min(nodes.length - 1, index + 1);
  nodes[index]?.scrollIntoView({ block: "center", behavior: "auto" });
}

export function ChangesOverlayHost() {
  const ui = useChangesUi();
  if (!ui.open && !ui.request) return null;
  return <ChangesOverlay />;
}

function ChangesOverlay() {
  const ui = useChangesUi();
  const adapter = getChangesAdapter();
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [chrome, setChrome] = useState<"phone" | "desktop">("desktop");
  const [list, setList] = useState<ChangesList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [page, setPage] = useState<FileDiffPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [agent, setAgent] = useState<AgentChangesContext | undefined>();
  const [rangeFrom, setRangeFrom] = useState(ui.scope.kind === "range" ? ui.scope.from : "HEAD");
  const [rangeTo, setRangeTo] = useState(ui.scope.kind === "range" ? ui.scope.to : "");
  const turnId = ui.scope.kind === "turn" ? ui.scope.turnId : ui.request?.scope.kind === "turn" ? ui.request.scope.turnId : undefined;
  const runId = ui.scope.kind === "agent" ? ui.scope.runId : ui.request?.scope.kind === "agent" ? ui.request.scope.runId : undefined;

  const find = useOverlayFind({
    host: bodyRef,
    open: ui.findOpen,
    modelText: page?.patch ?? "",
    onClose: () => setFindOpen(false),
  });

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void adapter.listChanges(ui.scope).then(
      (next) => {
        if (cancelled) return;
        setList(next);
        setListLoading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setListError(error instanceof Error ? error.message : "Could not read the changes.");
        setListLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, ui.scope]);

  useEffect(() => {
    if (ui.scope.kind !== "agent") {
      setAgent(undefined);
      return;
    }
    let cancelled = false;
    void adapter.getAgentContext?.(ui.scope.runId).then(
      (next) => {
        if (!cancelled) setAgent(next);
      },
      () => {
        if (!cancelled) setAgent(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, ui.scope]);

  const visibleRepos = useMemo(() => {
    const repos = list?.repos ?? [];
    if (!ui.repoFilter) return repos;
    return repos.filter((repo) => repo.repo === ui.repoFilter);
  }, [list, ui.repoFilter]);

  const files = useMemo(() => {
    const map = new Map<string, ChangedFile>();
    for (const repo of visibleRepos) {
      for (const file of repo.files) map.set(`${repo.repo}:${file.path}`, file);
    }
    return map;
  }, [visibleRepos]);

  const fileOrder = useMemo<OpenFile[]>(
    () => visibleRepos.flatMap((repo) => repo.files.map((file) => ({ repo: repo.repo, path: file.path }))),
    [visibleRepos],
  );

  const active = ui.active;
  const activeFile = active ? files.get(`${active.repo}:${active.path}`) : undefined;
  const activeRepo = active ? visibleRepos.find((repo) => repo.repo === active.repo) : undefined;

  useEffect(() => {
    if (!active || !activeFile) {
      setPage(null);
      setPageError(null);
      setPageLoading(false);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    setPageError(null);
    void adapter.getFileDiff(ui.scope, active.repo, active.path).then(
      (next) => {
        if (cancelled) return;
        setPage(next);
        setPageLoading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : "Could not read this file.");
        setPageLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, activeFile, adapter, ui.scope]);

  useEffect(() => {
    const node = overlayRef.current;
    const body = bodyRef.current;
    if (!node) return;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setChrome(overlayChromeLayout(node.clientWidth, rem));
      if (body) {
        const code = Number.parseFloat(getComputedStyle(body).fontSize);
        setUnifiedFallback(!splitColumnsFit(body.clientWidth, code));
      }
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(node);
    if (body) observer?.observe(body);
    return () => observer?.disconnect();
  }, [ui.open, active]);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const onCopy = () => {
      clipSelectionToCode(document.getSelection());
    };
    node.addEventListener("copy", onCopy);
    return () => node.removeEventListener("copy", onCopy);
  }, [page]);

  const totals = listTotals(visibleRepos);
  const emptyBody = page ? classifyDiffPage(page) : null;
  const lineCount = activeFile ? fileLineCount(activeFile) : 0;
  const large = Boolean(active && activeFile && shouldBoundExpansion(lineCount) && !isLargeRevealed(active.repo, active.path, ui.revealedLarge));
  const effectiveStyle = ui.unifiedFallback || ui.diffStyle === "unified" ? "unified" : "split";
  const gone = agent?.branchGone === true;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = overlayKeyAction(event.nativeEvent);
    if (!action) return;
    if (action === "close") {
      event.preventDefault();
      if (ui.findOpen) setFindOpen(false);
      else closeChanges();
      return;
    }
    event.preventDefault();
    if (action === "find") setFindOpen(true);
    else if (action === "next-file") cycleFile(fileOrder, 1);
    else if (action === "prev-file") cycleFile(fileOrder, -1);
    else if (action === "next-tab") cycleTab(1);
    else if (action === "prev-tab") cycleTab(-1);
    else if (action === "close-tab" && active) closeTab(active.repo, active.path);
    else if (action === "toggle-viewed" && active) toggleViewed(active.repo, active.path);
    else if (action === "toggle-unified") setDiffStyle(ui.diffStyle === "split" ? "unified" : "split");
    else if (action === "toggle-tree") setTreeOpen(!ui.treeOpen);
    else if (action === "next-hunk" && bodyRef.current) stepHunk(bodyRef.current, 1);
    else if (action === "prev-hunk" && bodyRef.current) stepHunk(bodyRef.current, -1);
  };

  const openFile = (repo: string, file: ChangedFile) => {
    addTab(repo, file.path);
    if (chrome === "phone") setTreeOpen(false);
  };

  let body: ReactNode;
  if (gone) body = <AgentGoneState />;
  else if (listLoading) body = <OverlayLoadingState />;
  else if (listError) body = <DiffErrorState message={listError} onRetry={() => setChangesScope({ ...ui.scope })} />;
  else if (!visibleRepos.some((repo) => repo.files.length || repo.error)) body = <NoChangesState />;
  else if (!active) body = <PickFileState />;
  else if (activeRepo?.error) body = <RepoFailedState repo={activeRepo.repo} message={activeRepo.error} onRetry={() => setChangesScope({ ...ui.scope })} />;
  else if (pageLoading) body = <DiffLoadingState path={active.path} />;
  else if (pageError) body = <DiffErrorState message={pageError} onRetry={() => active && addTab(active.repo, active.path)} />;
  else if (emptyBody) body = <EmptyBodyState body={emptyBody} />;
  else if (page && page.status === "deleted" && !page.patch.trim()) body = <DeletedFileState path={page.path} />;
  else if (large && active && activeFile) {
    body = (
      <LargeFileState
        path={active.path}
        lines={lineCount}
        onReveal={() => revealLargeFile(active.repo, active.path)}
      />
    );
  } else if (page) {
    body = (
      <Suspense fallback={<OverlayLoadingState />}>
        <DiffBody page={page} scope={ui.scope} diffStyle={effectiveStyle} />
      </Suspense>
    );
  } else body = <PickFileState />;

  const rail = (
    <ChangesRail
      repos={visibleRepos}
      active={active}
      viewed={ui.viewed}
      onOpen={openFile}
      onToggleViewed={(repo, file) => toggleViewed(repo, file.path)}
    />
  );

  return (
    <DialogPrimitive.Root open={ui.open} onOpenChange={(next) => { if (!next) closeChanges(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={overlayRef}
          data-slot="changes-overlay"
          aria-labelledby="changes-overlay-title"
          className="fixed inset-0 z-50 flex flex-col bg-bg text-ink outline-none"
          onKeyDown={onKeyDown}
        >
          <DialogPrimitive.Title id="changes-overlay-title" className="sr-only">
            Changes
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Read-only changes in this workspace. Escape returns to the conversation.
          </DialogPrimitive.Description>
          <ChangesToolbar
            scope={ui.scope}
            repos={list?.repos ?? []}
            repoFilter={ui.repoFilter}
            totals={totals}
            {...(agent ? { agent } : {})}
            rangeFrom={rangeFrom}
            rangeTo={rangeTo}
            canTurn={Boolean(turnId)}
            canAgent={Boolean(runId)}
            {...(turnId ? { turnId } : {})}
            {...(runId ? { runId } : {})}
            chrome={chrome}
            diffStyle={ui.diffStyle}
            onScope={setChangesScope}
            onRepoFilter={setRepoFilter}
            onRange={(from, to) => {
              setRangeFrom(from);
              setRangeTo(to);
              setChangesScope({ kind: "range", from, to });
            }}
            onDiffStyle={setDiffStyle}
            onClose={closeChanges}
            onOpenTree={() => setTreeOpen(true)}
          />
          {find.bar}
          <ChangesTabStrip
            tabs={ui.tabs}
            active={active}
            files={files}
            onSelect={(tab) => selectTab(tab.repo, tab.path)}
            onClose={(tab) => closeTab(tab.repo, tab.path)}
          />
          {ui.unifiedFallback && ui.fallbackSaid && ui.diffStyle === "split" ? <UnifiedFallbackNotice /> : null}
          <div className="flex min-h-0 min-w-0 flex-1">
            {chrome === "desktop" ? (
              <aside className="flex w-72 max-w-[40%] shrink-0 flex-col border-e border-line">{rail}</aside>
            ) : null}
            <div ref={bodyRef} data-slot="changes-body" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {body}
            </div>
          </div>
          {chrome === "phone" ? (
            <Sheet open={ui.treeOpen} onOpenChange={setTreeOpen}>
              <SheetContent side="left" className="p-0">
                <SheetTitle className="px-4 py-3">Changed files</SheetTitle>
                {rail}
              </SheetContent>
            </Sheet>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
