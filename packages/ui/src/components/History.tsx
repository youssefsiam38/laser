import { useEffect } from "react";
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

/** Session history (M1-T9): persisted entries with fork / jump actions. Tree shape shown by indentation of branches. */
export function History({ view, onRefresh, onFork, onJump, onClose }: Props) {
  useEffect(() => {
    void onRefresh();
  }, [onRefresh]);

  const entries = (view.entries as Entry[]).filter((e) => e.type === "message" || e.type === "label" || e.type === "compaction" || e.type === "branch_summary");
  // Depth = number of ancestors that have more than one child (a branch point).
  const children = new Map<string | null, number>();
  for (const e of view.entries as Entry[]) children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
  const byId = new Map((view.entries as Entry[]).map((e) => [e.id, e]));
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
                  <button className="link" onClick={() => void onFork(e.id)}>fork here</button>
                  <button className="link" onClick={() => void onJump(e.id)}>jump here</button>
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
