import { useEffect, useRef } from "react";
import { textOf, type SessionView } from "../store.js";

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  label?: string;
}

interface Props {
  view: SessionView;
  onRefresh: () => Promise<void>;
  onFork: (entryId: string) => Promise<void>;
  onJump: (entryId: string) => Promise<void>;
  onClose: () => void;
}

/** Session history (M1-T9): persisted entries with fork / jump actions. Branches are indented. */
export function History({ view, onRefresh, onFork, onJump, onClose }: Props) {
  // Refresh once per session (and when it settles), not on every render: the
  // callbacks change identity often and must not drive the effect.
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    void refresh.current();
  }, [view.path, view.running]);

  const all = view.entries as Entry[];
  const entries = all.filter((e) => e.type === "message" || e.type === "label" || e.type === "compaction" || e.type === "branch_summary");
  const children = new Map<string | null, number>();
  for (const e of all) children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
  const byId = new Map(all.map((e) => [e.id, e]));
  const depth = (e: Entry): number => {
    let d = 0;
    let p = e.parentId;
    while (p) {
      if ((children.get(p) ?? 0) > 1) d++;
      p = byId.get(p)?.parentId ?? null;
    }
    return d;
  };

  return (
    <aside className="history" aria-label="Session history">
      <div className="history-head">
        <strong>History</strong>
        <span className="muted">{entries.length} entries</span>
        <button className="link" onClick={() => void onRefresh()}>refresh</button>
        <button className="icon-btn" onClick={onClose} aria-label="Close history">×</button>
      </div>
      <div className="history-list">
        {entries.map((e) => {
          const role = e.message?.role ?? e.type;
          const text = e.message ? textOf(e.message.content) : (e.label ?? e.type);
          return (
            <div key={e.id} className={`history-row role-${role}`} style={{ marginLeft: depth(e) * 14 }}>
              <div className="history-meta">
                <span className="history-role">{role}</span>
                <code className="muted">{e.id}</code>
              </div>
              <div className="history-text">{text.slice(0, 160) || <span className="muted">(no text)</span>}</div>
              {e.type === "message" && (
                <div className="history-actions">
                  <button className="link" onClick={() => void onFork(e.id)} title="New session with history up to here; this message goes to the composer">fork here</button>
                  <button className="link" onClick={() => void onJump(e.id)} title="Move this session's cursor here">jump here</button>
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && <p className="muted">Nothing persisted yet.</p>}
      </div>
    </aside>
  );
}
