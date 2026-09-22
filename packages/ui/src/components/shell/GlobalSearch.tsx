import { sessionKindOf } from "@lasercode/protocol";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ThreadListSearch } from "@/components/assistant-ui/elements/thread-list.aui";
import { ThreadSearch, matchesThread, rankSearchThreads, threadSearchKeys, type SearchableThread } from "@/components/assistant-ui/elements/thread-search";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useWorkbench } from "@/components/workbench";
import { openConversationFind } from "@/components/thread/search-state";
import { sessionTitle, useCapability, useLaserStable, useLaserState } from "@/runtime";
import { WorkIdentity } from "@/components/project-work";
import { landWorkLink } from "@/project-work";
import { useWorkMentions } from "@/project-work/mentions";
import { shortCwd } from "@/format";
import { sessionStatus } from "./model.js";
import { SessionSearchProgress } from "./SessionSearchProgress.js";
import { useSessionSearch } from "./use-session-search.js";
import { groupNameOf, workspaceKindOf, workspacesOf } from "./session-groups.js";

export function openGlobalSearch() { window.dispatchEvent(new Event("global-session-search")); }

/**
 * Project work in the one search that crosses everything (M21-T9, D-355
 * "Outside the workspace").
 *
 * Keys match exactly and rank first: `TASK-44` finds TASK-44 above every
 * conversation that merely says those characters. Each project is read
 * through its own `project/work/search`, the current one first, and a result
 * opens the workspace at that revision rather than a conversation.
 */
function WorkResults({ query, onOpen }: { query: string; onOpen: () => void }) {
  const { currentProject, projects, projectInfo } = useLaserStable();
  const sources = useMemo(
    () => projects.map((cwd) => ({ cwd, name: projectInfo[cwd]?.name ?? shortCwd(cwd) })),
    [projects, projectInfo],
  );
  const work = useWorkMentions(query.trim(), true, { currentCwd: currentProject, projects: sources, freeText: true });
  if (work.candidates.length === 0) return null;
  return (
    <section aria-label="Project work" className="flex flex-col gap-1 px-4 py-3 hairline-b">
      <h3 className="eyebrow">Project work</h3>
      {work.candidates.map((candidate) => (
        <button
          key={`${candidate.ref.projectId}:${candidate.ref.entityId}`}
          type="button"
          data-slot="global-search-work"
          onClick={() => {
            landWorkLink({
              projectId: candidate.ref.projectId,
              kind: candidate.kind,
              entityId: candidate.ref.entityId,
              revisionId: candidate.ref.revisionId,
            });
            onOpen();
          }}
          className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-start transition-colors duration-(--motion-instant) hover:bg-surface-2 focus-visible:outline focus-visible:outline-live"
        >
          <WorkIdentity workKey={candidate.key} kind={candidate.kind} title={candidate.title} className="flex-1" />
          <span className="shrink-0 text-xs text-ink-3">{candidate.project.current ? "This project" : candidate.project.name}</span>
        </button>
      ))}
    </section>
  );
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const search = useCapability("session/search");
  useEffect(() => {
    if (search.state !== "available") { setOpen(false); return; }
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("global-session-search", show);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("global-session-search", show); };
  }, [search.state]);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="flex h-[80dvh] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
    <div className="border-b border-line px-5 py-4 pe-12"><DialogTitle className="flex items-center gap-2"><Search className="size-4 text-ink-3" />Search all sessions</DialogTitle><DialogDescription className="mt-1">Find messages, reasoning and tool activity. Recent conversations first, including archives.</DialogDescription></div>
    {open && <GlobalSearchBody close={() => setOpen(false)} />}
  </DialogContent></Dialog>;
}

function GlobalSearchBody({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const [opening, setOpening] = useState(false);
  const { actions } = useLaserStable();
  useEffect(() => actions.expandCatalog?.(), [actions]);
  const sessions = useLaserState(s => s.sessions);
  const views = useLaserState(s => s.open);
  const workspaces = useLaserState(workspacesOf);
  const workbench = useWorkbench();
  const search = useSessionSearch(query);
  const rows = useMemo<SearchableThread[]>(() => {
    const hits = new Map(search.hits.map(h => [h.path, h]));
    return sessions.filter(s => !search.after || s.modifiedAt >= search.after).map(s => {
      const kind = s.agent && sessionKindOf(s.agent.kind) === "chat" ? ("chat" as const) : workspaceKindOf(s.cwd, workspaces);
      return { id: s.path, title: sessionTitle(s, views[s.path]), group: kind ? groupNameOf(s.cwd, kind) : shortCwd(s.cwd), preview: s.firstMessage ?? "", modifiedAt: s.modifiedAt, status: sessionStatus(views[s.path], s), matchCount: hits.get(s.path)?.count, excerpt: hits.get(s.path)?.excerpt, matchSource: hits.get(s.path)?.source };
    }).filter(s => matchesThread(s, query)).sort(rankSearchThreads);
  }, [sessions, views, search.hits, search.after, query, workspaces]);
  useEffect(() => { if (!rows.some(r => r.id === activeId)) setActiveId(rows[0]?.id); }, [rows, activeId]);
  const select = async (id: string) => {
    if (opening) return;
    const session = sessions.find(s => s.path === id);
    if (!session) return;
    setOpening(true);
    try {
      await actions.openSession(id);
      workbench.close();
      close();
      requestAnimationFrame(() => requestAnimationFrame(() => openConversationFind(query, rows.find(row => row.id === id)?.matchSource)));
    } catch { actions.toast("error", "Could not open this session. Check the host connection and try again."); setOpening(false); }
  };
  return <>
    <div className="px-4 py-3"><ThreadListSearch autoFocus maxLength={200} value={query} onValueChange={setQuery} placeholder="Search every conversation…" aria-label="Search all sessions" aria-controls="global-search-results" aria-activedescendant={activeId ? `global-search-results-${activeId}` : undefined} role="combobox" aria-expanded={Boolean(query.trim())} onKeyDown={threadSearchKeys(rows, activeId, setActiveId, id => void select(id))} /></div>
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={search.busy || opening}>
      {query.trim() ? <WorkResults query={query} onOpen={close} /> : null}
      {query.trim() ? <ThreadSearch id="global-search-results" grouped={false} loading={search.busy} threads={rows} query={query} activeId={activeId} onActiveChange={setActiveId} onSelect={id => void select(id)} /> : <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-ink-3"><Search className="size-6" /><p>A phrase, an error, an idea.<br />Start with the last 30 days, then explore older history.</p></div>}
    </div>
    {query.trim() && <SessionSearchProgress search={search} />}
  </>;
}
