import { useEffect, useState } from "react";
import { ChevronDown, Columns2, PanelLeft, Rows2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import type { WorkspaceRepository } from "@lasercode/protocol";

import { scopeLabel, scopeShortLabel, type OverlayToolbarPlan } from "./classify.js";
import type { AgentChangesContext, ChangesScope, ChangesScopeKind, ChangedRepo } from "./contract.js";
import { ChangesGitActions, useGitToolbarState } from "./git-toolbar.js";
import type { DiffStylePref } from "./prefs.js";
import { AgentCheckoutLine } from "./states.js";
import { ChangeTotals } from "./totals.js";
import { repoLeafName } from "./git-model.js";
import { shouldShowRepoFilter } from "./workspace-shape.js";

const SCOPES: ChangesScopeKind[] = ["session", "turn", "uncommitted", "range", "agent"];

const ALL_REPOSITORIES = "All repositories";
const ALL_REPOSITORIES_SHORT = "All repos";

export function ChangesToolbar({
  scope,
  repos,
  workspaceRepos,
  repoFilter,
  totals: totalCounts,
  agent,
  rangeFrom,
  rangeTo,
  canTurn,
  canAgent,
  turnId,
  runId,
  plan,
  diffStyle,
  unifiedFallback,
  onScope,
  onRepoFilter,
  onRange,
  onDiffStyle,
  onClose,
  onOpenTree,
  activeRepo,
}: {
  scope: ChangesScope;
  repos: readonly ChangedRepo[];
  workspaceRepos?: readonly WorkspaceRepository[];
  repoFilter: string | null;
  totals: { added: number; removed: number };
  agent?: AgentChangesContext;
  rangeFrom: string;
  rangeTo: string;
  canTurn: boolean;
  canAgent: boolean;
  turnId?: string;
  runId?: string;
  /** What this width can carry (`overlayToolbarPlan`); never a type size. */
  plan: OverlayToolbarPlan;
  diffStyle: DiffStylePref;
  unifiedFallback: boolean;
  onScope: (scope: ChangesScope) => void;
  onRepoFilter: (repo: string | null) => void;
  onRange: (from: string, to: string) => void;
  onDiffStyle: (style: DiffStylePref) => void;
  onClose: () => void;
  onOpenTree: () => void;
  activeRepo?: string;
}) {
  const namedRepos = repos.filter((repo) => !repo.error);
  const filterEntries = workspaceRepos
    ? workspaceRepos.map((repo) => ({ value: repo.root, label: repo.name }))
    : namedRepos.map((repo) => ({ value: repo.repo, label: repo.repo }));
  const showRepos = shouldShowRepoFilter(filterEntries.length);
  const gitState = useGitToolbarState({ repos, repoFilter, ...(activeRepo ? { activeRepo } : {}) });
  const long = plan.repo === "long";
  const repoText = repoFilter
    ? long
      ? repoFilter
      : repoLeafName(repoFilter)
    : long
      ? ALL_REPOSITORIES
      : ALL_REPOSITORIES_SHORT;
  const totals = (
    <ChangeTotals added={totalCounts.added} removed={totalCounts.removed} empty="no changes" />
  );
  const repoPicker = showRepos ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          data-slot="changes-repo-filter"
          aria-label={`Repository filter: ${repoText}`}
          className={cn("min-w-0 gap-1 pointer-coarse:min-h-11", long ? "max-w-44" : "max-w-28")}
        >
          {/* A repository is a path, so it stays mono — but at the body size,
              beside the other controls, not at the 12px floor. */}
          <span className="min-w-0 truncate font-mono text-sm leading-sm">{repoText}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={repoFilter ?? ""} onValueChange={(value) => onRepoFilter(value || null)}>
          <DropdownMenuRadioItem value="">{ALL_REPOSITORIES}</DropdownMenuRadioItem>
          {filterEntries.map((repo) => (
            <DropdownMenuRadioItem key={repo.value} value={repo.value}>
              <span className="typed">{repo.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const pickScope = (kind: string) => {
    if (kind === "session") onScope({ kind: "session" });
    else if (kind === "uncommitted") onScope({ kind: "uncommitted" });
    else if (kind === "turn" && turnId) onScope({ kind: "turn", turnId });
    else if (kind === "agent" && runId) onScope({ kind: "agent", runId });
    else if (kind === "range") onScope({ kind: "range", from: rangeFrom || "HEAD", to: rangeTo || "HEAD" });
  };

  return (
    <header
      data-slot="changes-toolbar"
      data-tier={plan.tier}
      className="flex shrink-0 flex-col gap-1 hairline-b px-2 py-1.5 pt-[env(safe-area-inset-top)]"
    >
      <div className="flex min-w-0 items-center gap-1">
        {plan.tree !== "hidden" ? (
          plan.tree === "icon" ? (
            <TooltipIconButton
              size="icon"
              className="pointer-coarse:size-11"
              tooltip="Changed files"
              shortcut="B"
              side="bottom"
              onClick={onOpenTree}
            >
              <PanelLeft />
            </TooltipIconButton>
          ) : (
            <Button variant="ghost" onClick={onOpenTree} className="gap-1.5 pointer-coarse:min-h-11">
              <PanelLeft />
              Files
            </Button>
          )
        ) : null}
        {plan.title ? <h1 className="px-1 text-sm font-semibold text-ink">Changes</h1> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              data-slot="changes-scope"
              /* The accessible name carries the visible words verbatim, so the
                 short label is still what a voice user says. */
              aria-label={`Scope: ${plan.scope === "long" ? scopeLabel(scope.kind) : scopeShortLabel(scope.kind)}`}
              className="gap-1 pointer-coarse:min-h-11"
            >
              {plan.scope === "long" ? scopeLabel(scope.kind) : scopeShortLabel(scope.kind)}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={scope.kind} onValueChange={pickScope}>
              {SCOPES.map((kind) => (
                <DropdownMenuRadioItem
                  key={kind}
                  value={kind}
                  disabled={(kind === "turn" && !canTurn) || (kind === "agent" && !canAgent)}
                >
                  {scopeLabel(kind)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {plan.totals === "row" ? (
          <>
            {repoPicker}
            <span className="ms-1">{totals}</span>
          </>
        ) : null}
        <div className="ms-auto flex min-w-0 items-center gap-1">
          {plan.split ? (
            <TooltipIconButton
              size="icon"
              className="pointer-coarse:size-11"
              tooltip={unifiedFallback ? "Split needs two columns of code" : diffStyle === "split" ? "Unified view" : "Split view"}
              {...(unifiedFallback ? {} : { shortcut: "U" })}
              disabled={unifiedFallback}
              onClick={() => onDiffStyle(diffStyle === "split" ? "unified" : "split")}
            >
              {diffStyle === "split" ? <Rows2 /> : <Columns2 />}
            </TooltipIconButton>
          ) : null}
          <ChangesGitActions state={gitState} git={plan.git} commit={plan.commit} />
          {plan.esc ? <Kbd>Esc</Kbd> : null}
          <TooltipIconButton size="icon" className="pointer-coarse:size-11" tooltip="Close" shortcut="Esc" onClick={onClose}>
            <X />
          </TooltipIconButton>
        </div>
      </div>
      {plan.totals === "second-row" ? (
        <div className="flex min-w-0 items-center gap-1">
          {repoPicker}
          <span className="ms-auto pe-1">{totals}</span>
        </div>
      ) : null}
      {scope.kind === "range" ? (
        <RangeFields from={rangeFrom} to={rangeTo} onCommit={onRange} />
      ) : null}
      {agent ? <AgentCheckoutLine context={agent} className="px-1" /> : null}
      {/* Nothing else below the row. The git host's status used to live here,
          in attention colour, as the second thing a person read on a screen
          they opened to read a diff; it is now inside the Git menu
          (`git-menu-status`), beside the controls it explains. */}
    </header>
  );
}

export function committedRange(
  draftFrom: string,
  draftTo: string,
  from: string,
  to: string,
): { from: string; to: string } | null {
  const nextFrom = draftFrom.trim();
  const nextTo = draftTo.trim();
  if (!nextFrom || !nextTo) return null;
  if (nextFrom === from && nextTo === to) return null;
  return { from: nextFrom, to: nextTo };
}

export function RangeFields({
  from,
  to,
  onCommit,
}: {
  from: string;
  to: string;
  onCommit: (from: string, to: string) => void;
}) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
  }, [from, to]);
  const commit = () => {
    const next = committedRange(draftFrom, draftTo, from, to);
    if (!next) return;
    onCommit(next.from, next.to);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
      <label className="flex items-center gap-1.5 text-sm leading-sm text-ink-2">
        From
        <Input
          value={draftFrom}
          onChange={(event) => setDraftFrom(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="h-8 w-40 text-sm pointer-coarse:min-h-11 pointer-coarse:text-base"
          aria-label="Range start"
        />
      </label>
      <label className="flex items-center gap-1.5 text-sm leading-sm text-ink-2">
        To
        <Input
          value={draftTo}
          onChange={(event) => setDraftTo(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="h-8 w-40 text-sm pointer-coarse:min-h-11 pointer-coarse:text-base"
          aria-label="Range end"
        />
      </label>
    </div>
  );
}
