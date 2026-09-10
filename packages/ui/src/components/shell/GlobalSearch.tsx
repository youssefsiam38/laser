import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ThreadListSearch } from "@/components/assistant-ui/elements/thread-list.aui";
import { ThreadSearch, matchesThread, rankSearchThreads, threadSearchKeys, type SearchableThread } from "@/components/assistant-ui/elements/thread-search";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useWorkbench } from "@/components/workbench";
import { openConversationFind } from "@/components/thread/search-state";
import { sessionKindTab, sessionTitle, useLaserStable, useLaserState } from "@/runtime";
import { shortCwd } from "@/format";
import { sessionStatus } from "./model.js";
import { SessionSearchProgress } from "./SessionSearchProgress.js";
import { useSessionSearch } from "./use-session-search.js";
import { groupNameOf, sessionsList, workspaceKindOf, workspacesOf } from "./session-groups.js";

export function openGlobalSearch() { window.dispatchEvent(new Event("global-session-search")); }

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("global-session-search", show);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("global-session-search", show); };
  }, []);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="flex h-[80dvh] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
    <div className="border-b border-line px-5 py-4 pe-12"><DialogTitle className="flex items-center gap-2"><Search className="size-4 text-ink-3" />Search all sessions</DialogTitle><DialogDescription className="mt-1">Find messages, reasoning and tool activity. Recent conversations first, including archives.</DialogDescription></div>
    {open && <GlobalSearchBody close={() => setOpen(false)} />}
  </DialogContent></Dialog>;
}

function GlobalSearchBody({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const [opening, setOpening] = useState(false);
  const { actions, setCurrentProject } = useLaserStable();
  const sessions = useLaserState(s => s.sessions);
  const views = useLaserState(s => s.open);
  const workspaces = useLaserState(workspacesOf);
  const workbench = useWorkbench();
  const search = useSessionSearch(query);
  const rows = useMemo<SearchableThread[]>(() => {
    const hits = new Map(search.hits.map(h => [h.path, h]));
    return sessions.filter(s => !search.after || s.modifiedAt >= search.after).map(s => {
      const kind = s.agent?.kind === "beam" || s.agent?.kind === "chat" ? s.agent.kind : workspaceKindOf(s.cwd, workspaces);
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
      const tab = sessionKindTab(session, workspaces);
      sessionsList.setTab(tab);
      if (tab === "code" && session.agent?.kind !== "beam") setCurrentProject(session.cwd);
      await actions.openSession(id);
      workbench.close();
      close();
      requestAnimationFrame(() => requestAnimationFrame(() => openConversationFind(query, rows.find(row => row.id === id)?.matchSource)));
    } catch { actions.toast("error", "Could not open this session. Check the host connection and try again."); setOpening(false); }
  };
  return <>
    <div className="px-4 py-3"><ThreadListSearch autoFocus maxLength={200} value={query} onValueChange={setQuery} placeholder="Search every conversation…" aria-label="Search all sessions" aria-controls="global-search-results" aria-activedescendant={activeId ? `global-search-results-${activeId}` : undefined} role="combobox" aria-expanded={Boolean(query.trim())} onKeyDown={threadSearchKeys(rows, activeId, setActiveId, id => void select(id))} /></div>
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={search.busy || opening}>
      {query.trim() ? <ThreadSearch id="global-search-results" grouped={false} loading={search.busy} threads={rows} query={query} activeId={activeId} onActiveChange={setActiveId} onSelect={id => void select(id)} /> : <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-ink-3"><Search className="size-6" /><p>A phrase, an error, an idea.<br />Start with the last 30 days, then explore older history.</p></div>}
    </div>
    {query.trim() && <SessionSearchProgress search={search} />}
  </>;
}
