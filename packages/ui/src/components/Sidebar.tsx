import { useMemo, useState } from "react";
import type { SessionSummary } from "@piorbit/protocol";
import type { SessionView } from "../store.js";

interface Props {
  sessions: SessionSummary[];
  open: Record<string, SessionView>;
  current: string | undefined;
  connection: "connecting" | "open" | "closed";
  onOpen: (path: string) => void;
  onNew: (cwd: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

export function Sidebar({ sessions, open, current, connection, onOpen, onNew, onSelect, onClose }: Props) {
  const [newCwd, setNewCwd] = useState("");
  const byProject = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of sessions) map.set(s.cwd, [...(map.get(s.cwd) ?? []), s]);
    return [...map.entries()];
  }, [sessions]);

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <span className="brand">piorbit</span>
        <span className={`conn conn-${connection}`} title={`host ${connection}`} />
        <button className="icon-btn hide-desktop" onClick={onClose} aria-label="Close sidebar">×</button>
      </div>
      <form
        className="new-session"
        onSubmit={(e) => {
          e.preventDefault();
          if (newCwd.trim()) onNew(newCwd.trim());
        }}
      >
        <input value={newCwd} onChange={(e) => setNewCwd(e.target.value)} placeholder="/path/to/project" aria-label="Project directory" />
        <button type="submit" disabled={!newCwd.trim() || connection !== "open"}>New</button>
      </form>
      <nav className="session-list">
        {byProject.length === 0 && <p className="muted">No sessions yet.</p>}
        {byProject.map(([cwd, list]) => (
          <section key={cwd}>
            <header className="project">
              <span title={cwd}>{shortCwd(cwd)}</span>
              <button className="link" onClick={() => onNew(cwd)} disabled={connection !== "open"}>+ new</button>
            </header>
            {list.map((s) => {
              const view = open[s.path];
              const active = current === s.path;
              return (
                <button
                  key={s.path}
                  className={`session ${active ? "active" : ""}`}
                  onClick={() => (view ? onSelect(s.path) : onOpen(s.path))}
                  title={s.path}
                >
                  <span className={`dot ${view?.running ? "running" : view?.dialogs.length ? "waiting" : ""}`} />
                  <span className="session-name">{s.name ?? view?.title ?? s.firstMessage ?? s.id.slice(0, 8)}</span>
                  <time className="muted">{new Date(s.modifiedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                </button>
              );
            })}
          </section>
        ))}
      </nav>
    </aside>
  );
}
