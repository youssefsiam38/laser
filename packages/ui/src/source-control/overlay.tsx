import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { collectOpenShadowRoots } from "@/components/thread/find-ranges.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

import {
  classifyDiffPage,
  codeSizeFromTheme,
  fileLineCount,
  listTotals,
  overlayChromeLayout,
  shouldBoundExpansion,
  splitColumnsFit,
} from "./classify.js";
import type { AgentChangesContext, ChangedFile, ChangesList, FileDiffPage } from "./contract.js";
import { handleOverlayCopy } from "./copy.js";
import { getChangesAdapter, getChangesAdapterSource } from "./data.js";
import { appendPatchPage } from "./diff-files.js";
import { CHANGES_FILE_FAILED, CHANGES_LIST_FAILED, personFacingChangesError } from "./errors.js";
import { useBindHostChangesAdapter } from "./host-bind.js";
import { nextHunkIndex } from "./hunk.js";
import { overlayKeyAction } from "./keyboard.js";
import { useOverlayFind } from "./overlay-find.js";
import { changesBodyState } from "./overlay-state.js";
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
  TruncatedPatchState,
  UnifiedFallbackNotice,
} from "./states.js";
import {
  addTab,
  closeChanges,
  closeTab,
  cycleFile,
  cycleTab,
  dismissFallbackNotice,
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
import { CHANGES_DIFF_PANEL_ID, ChangesTabStrip } from "./tabs.js";
import { ChangesToolbar } from "./toolbar.js";

const DiffBody = lazy(() => import("./diff-body.js").then((module) => ({ default: module.DiffBody })));

function stepHunk(host: HTMLElement, delta: number): void {
  const roots = collectOpenShadowRoots(host);
  const nodes = roots.flatMap((root) => [...root.querySelectorAll("[data-separator]")]);
  if (!nodes.length) return;
  const viewMid = host.getBoundingClientRect().top + host.clientHeight / 2;
  const index = nextHunkIndex(
    nodes.map((node) => node.getBoundingClientRect().top),
    viewMid,
    delta,
  );
  if (index === undefined) return;
  nodes[index]?.scrollIntoView({ block: "center", behavior: "auto" });
}

export function ChangesOverlayHost() {
  const [bindHost] = useState(() => getChangesAdapterSource() === "none");
  return (
    <>
      {bindHost ? <HostChangesBinder /> : null}
      <ChangesOverlaySurface />
    </>
  );
}

function HostChangesBinder() {
  useBindHostChangesAdapter();
  return null;
}

function ChangesOverlaySurface() {
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
  const [moreLoading, setMoreLoading] = useState(false);
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
        setListError(personFacingChangesError(error, CHANGES_LIST_FAILED));
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
        setPageError(personFacingChangesError(error, CHANGES_FILE_FAILED));
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
      const styles = getComputedStyle(document.documentElement);
      const rem = Number.parseFloat(styles.fontSize);
      const code = Number.parseFloat(styles.getPropertyValue("--text-code"));
      setChrome(overlayChromeLayout(node.clientWidth, rem));
      if (body) {
        setUnifiedFallback(!splitColumnsFit(body.clientWidth, codeSizeFromTheme(code, rem)));
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
    const onCopy = (event: ClipboardEvent) => {
      handleOverlayCopy(event, node);
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
  const bodyState = changesBodyState({
    gone,
    listLoading,
    listError,
    hasContent: visibleRepos.some((repo) => repo.files.length || repo.error),
    active,
    repoError: activeRepo?.error ? { repo: activeRepo.repo, message: activeRepo.error } : undefined,
    pageLoading,
    pageError,
    emptyBody,
    page,
    large,
    lineCount,
  });

  const runAction = (action: ReturnType<typeof overlayKeyAction>) => {
    if (!action) return false;
    if (action === "close") {
      if (ui.findOpen) setFindOpen(false);
      else if (ui.treeOpen) setTreeOpen(false);
      else closeChanges();
      return true;
    }
    if (action === "find") setFindOpen(true);
    else if (action === "next-file") cycleFile(fileOrder, 1);
    else if (action === "prev-file") cycleFile(fileOrder, -1);
    else if (action === "next-tab") cycleTab(1);
    else if (action === "prev-tab") cycleTab(-1);
    else if (action === "close-tab" && active) closeTab(active.repo, active.path);
    else if (action === "toggle-viewed" && active) toggleViewed(active.repo, active.path);
    else if (action === "toggle-unified" && !ui.unifiedFallback) setDiffStyle(ui.diffStyle === "split" ? "unified" : "split");
    else if (action === "toggle-tree") setTreeOpen(!ui.treeOpen);
    else if (action === "next-hunk" && bodyRef.current) stepHunk(bodyRef.current, 1);
    else if (action === "prev-hunk" && bodyRef.current) stepHunk(bodyRef.current, -1);
    return true;
  };
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  useEffect(() => {
    if (!ui.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = overlayKeyAction(event);
      if (!action) return;
      event.preventDefault();
      runActionRef.current(action);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ui.open]);

  const openFile = (repo: string, file: ChangedFile) => {
    addTab(repo, file.path);
    if (chrome === "phone") setTreeOpen(false);
  };

  const loadMore = () => {
    if (!active || !page || page.truncated !== true || page.nextOffset === undefined || moreLoading) return;
    setMoreLoading(true);
    void adapter.getFileDiff(ui.scope, active.repo, active.path, { offset: page.nextOffset }).then(
      (next) => {
        setPage((current) => (current ? appendPatchPage(current, next) : next));
        setMoreLoading(false);
      },
      (error: unknown) => {
        setPageError(personFacingChangesError(error, CHANGES_FILE_FAILED));
        setMoreLoading(false);
      },
    );
  };

  let body: ReactNode;
  switch (bodyState.kind) {
    case "gone":
      body = <AgentGoneState />;
      break;
    case "list-loading":
      body = <OverlayLoadingState />;
      break;
    case "list-error":
      body = <DiffErrorState message={bodyState.message} onRetry={() => setChangesScope({ ...ui.scope })} />;
      break;
    case "empty":
      body = <NoChangesState />;
      break;
    case "pick":
      body = <PickFileState />;
      break;
    case "repo-error":
      body = <RepoFailedState repo={bodyState.repo} message={bodyState.message} onRetry={() => setChangesScope({ ...ui.scope })} />;
      break;
    case "page-loading":
      body = <DiffLoadingState path={bodyState.path} />;
      break;
    case "page-error":
      body = <DiffErrorState message={bodyState.message} onRetry={() => active && addTab(active.repo, active.path)} />;
      break;
    case "empty-body":
      body = <EmptyBodyState body={bodyState.body} />;
      break;
    case "deleted":
      body = <DeletedFileState path={bodyState.path} />;
      break;
    case "large":
      body = (
        <LargeFileState
          path={bodyState.path}
          lines={bodyState.lines}
          onReveal={() => active && revealLargeFile(active.repo, active.path)}
        />
      );
      break;
    case "diff":
      body = (
        <Suspense fallback={<OverlayLoadingState />}>
          <DiffBody page={bodyState.page} scope={ui.scope} diffStyle={effectiveStyle} />
        </Suspense>
      );
      break;
  }

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
    <Dialog open={ui.open} onOpenChange={(next) => { if (!next) closeChanges(); }}>
      <DialogContent
        ref={overlayRef}
        showCloseButton={false}
        data-slot="changes-overlay"
        aria-labelledby="changes-overlay-title"
        className="inset-0 top-0 flex h-dvh max-h-dvh w-full max-w-full translate-y-0 flex-col gap-0 rounded-none border-0 bg-bg p-0 shadow-none sm:max-w-full"
      >
        <DialogTitle id="changes-overlay-title" className="sr-only">
          Changes
        </DialogTitle>
        <DialogDescription className="sr-only">
          Read-only changes in this workspace. Escape returns to the conversation.
        </DialogDescription>
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
          unifiedFallback={ui.unifiedFallback}
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
        {ui.unifiedFallback && !ui.fallbackSaid ? <UnifiedFallbackNotice onDismiss={dismissFallbackNotice} /> : null}
        <div className="flex min-h-0 min-w-0 flex-1">
          {chrome === "desktop" ? (
            <aside className="flex w-72 max-w-[40%] shrink-0 flex-col border-e border-line">{rail}</aside>
          ) : null}
          <div
            ref={bodyRef}
            id={CHANGES_DIFF_PANEL_ID}
            role="tabpanel"
            data-slot="changes-body"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {body}
            {bodyState.kind === "diff" && page?.truncated ? (
              <TruncatedPatchState onMore={loadMore} loading={moreLoading} />
            ) : null}
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
      </DialogContent>
    </Dialog>
  );
}
