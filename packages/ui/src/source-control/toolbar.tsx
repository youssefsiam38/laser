import { useEffect, useState } from "react";
import { ChevronDown, Columns2, Rows2, X } from "lucide-react";

import { DiffStat } from "@/components/assistant-ui/elements/code-diff.js";
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

import { scopeLabel } from "./classify.js";
import type { AgentChangesContext, ChangesScope, ChangesScopeKind, ChangedRepo } from "./contract.js";
import type { DiffStylePref } from "./prefs.js";
import { AgentCheckoutLine } from "./states.js";

const SCOPES: ChangesScopeKind[] = ["session", "turn", "uncommitted", "range", "agent"];

export function ChangesToolbar({
  scope,
  repos,
  repoFilter,
  totals,
  agent,
  rangeFrom,
  rangeTo,
  canTurn,
  canAgent,
  turnId,
  runId,
  chrome,
  diffStyle,
  unifiedFallback,
  onScope,
  onRepoFilter,
  onRange,
  onDiffStyle,
  onClose,
  onOpenTree,
}: {
  scope: ChangesScope;
  repos: readonly ChangedRepo[];
  repoFilter: string | null;
  totals: { added: number; removed: number };
  agent?: AgentChangesContext;
  rangeFrom: string;
  rangeTo: string;
  canTurn: boolean;
  canAgent: boolean;
  turnId?: string;
  runId?: string;
  chrome: "phone" | "desktop";
  diffStyle: DiffStylePref;
  unifiedFallback: boolean;
  onScope: (scope: ChangesScope) => void;
  onRepoFilter: (repo: string | null) => void;
  onRange: (from: string, to: string) => void;
  onDiffStyle: (style: DiffStylePref) => void;
  onClose: () => void;
  onOpenTree: () => void;
}) {
  const namedRepos = repos.filter((repo) => !repo.error);
  const showRepos = namedRepos.length > 1;
  const pickScope = (kind: string) => {
    if (kind === "session") onScope({ kind: "session" });
    else if (kind === "uncommitted") onScope({ kind: "uncommitted" });
    else if (kind === "turn" && turnId) onScope({ kind: "turn", turnId });
    else if (kind === "agent" && runId) onScope({ kind: "agent", runId });
    else if (kind === "range") onScope({ kind: "range", from: rangeFrom || "HEAD", to: rangeTo || "HEAD" });
  };

  return (
    <header data-slot="changes-toolbar" className="flex shrink-0 flex-col gap-1 border-b border-line px-2 py-1.5 pt-[env(safe-area-inset-top)]">
      <div className="flex min-w-0 items-center gap-1">
        {chrome === "phone" ? (
          <Button variant="ghost" size="sm" onClick={onOpenTree} className="[@media(pointer:coarse)]:min-h-11">
            Files
          </Button>
        ) : null}
        <h1 className="px-2 text-sm font-semibold text-ink">Changes</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 [@media(pointer:coarse)]:min-h-11">
              {scopeLabel(scope.kind)}
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
        {showRepos ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="max-w-40 gap-1 [@media(pointer:coarse)]:min-h-11">
                <span className="typed min-w-0 truncate">{repoFilter ?? "All repositories"}</span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={repoFilter ?? ""} onValueChange={(value) => onRepoFilter(value || null)}>
                <DropdownMenuRadioItem value="">All repositories</DropdownMenuRadioItem>
                {namedRepos.map((repo) => (
                  <DropdownMenuRadioItem key={repo.repo} value={repo.repo}>
                    <span className="typed">{repo.repo}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <DiffStat added={totals.added} removed={totals.removed} className="ms-1 hidden sm:inline-flex" />
        <div className="ms-auto flex min-w-0 items-center gap-1">
          <TooltipIconButton
            tooltip={unifiedFallback ? "Split needs two columns of code" : diffStyle === "split" ? "Unified view" : "Split view"}
            {...(unifiedFallback ? {} : { shortcut: "U" })}
            disabled={unifiedFallback}
            onClick={() => onDiffStyle(diffStyle === "split" ? "unified" : "split")}
          >
            {diffStyle === "split" ? <Rows2 /> : <Columns2 />}
          </TooltipIconButton>
          {/* TODO(M18-T6): git actions (commit, push, branch, PR) live in this slot. Do not invent them in this milestone. */}
          <div data-slot="changes-git-actions" />
          <Kbd className="hidden sm:inline-flex">Esc</Kbd>
          <TooltipIconButton tooltip="Close" shortcut="Esc" onClick={onClose}>
            <X />
          </TooltipIconButton>
        </div>
      </div>
      {scope.kind === "range" ? (
        <RangeFields from={rangeFrom} to={rangeTo} onCommit={onRange} />
      ) : null}
      {agent ? <div className="px-2"><AgentCheckoutLine context={agent} /></div> : null}
      <p className={cn("px-2 text-xs text-ink-3", totals.added || totals.removed ? "sm:hidden" : "hidden")}>
        <DiffStat added={totals.added} removed={totals.removed} />
      </p>
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
    <div className="flex flex-wrap items-center gap-2 px-2 pb-1">
      <label className="flex items-center gap-1 text-xs text-ink-2">
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
          className="h-7 w-40 text-sm [@media(pointer:coarse)]:text-base"
          aria-label="Range start"
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-ink-2">
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
          className="h-7 w-40 text-sm [@media(pointer:coarse)]:text-base"
          aria-label="Range end"
        />
      </label>
    </div>
  );
}
