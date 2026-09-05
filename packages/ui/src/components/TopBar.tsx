import { useEffect, useState } from "react";
import type { ModelRef, SessionState, ThinkingLevel } from "@piorbit/protocol";
import type { SessionView } from "../store.js";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface Props {
  view: SessionView | undefined;
  connection: "connecting" | "open" | "closed";
  historyOpen: boolean;
  onMenu: () => void;
  onSetModel: (model: SessionState["model"]) => Promise<void>;
  onSetThinking: (level: ThinkingLevel) => Promise<void>;
  onListModels: () => Promise<ModelRef[]>;
  onRename: (name: string) => Promise<void>;
  onCompact: () => Promise<void>;
  onToggleHistory: () => void;
}

export function TopBar({ view, connection, historyOpen, onMenu, onSetModel, onSetThinking, onListModels, onRename, onCompact, onToggleHistory }: Props) {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!picking) return;
    void onListModels().then(setModels);
  }, [picking, onListModels]);

  const model = view?.state.model;
  const shown = models.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
  const usage = view?.state.contextUsage;
  const name = view ? (view.state.name ?? view.title ?? view.state.id.slice(0, 8)) : "piorbit";

  const startEdit = () => {
    if (!view) return;
    setDraft(view.state.name ?? "");
    setEditing(true);
  };
  const commit = async () => {
    setEditing(false);
    if (view && draft.trim() && draft.trim() !== view.state.name) await onRename(draft.trim());
  };

  return (
    <header className="topbar">
      <button className="icon-btn hide-desktop" onClick={onMenu} aria-label="Sessions">☰</button>
      <div className="topbar-title" title={view ? `${view.path} (double-click to rename)` : undefined} onDoubleClick={startEdit}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Session name"
          />
        ) : (
          <>
            {name}
            {view && <span className="muted"> · {view.state.cwd.split("/").slice(-1)[0]}</span>}
          </>
        )}
      </div>
      {view && (
        <div className="topbar-controls">
          <button className="pill" onClick={() => setPicking((v) => !v)} title="Model">
            {model ? `${model.provider}/${model.id}` : "no model"}
          </button>
          <select className="pill" value={view.state.thinkingLevel} onChange={(e) => void onSetThinking(e.target.value as ThinkingLevel)} title="Thinking level">
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          {usage && usage.percent !== null && (
            <button className="pill muted" onClick={() => void onCompact()} title={`${usage.tokens ?? "?"} / ${usage.contextWindow} tokens. Click to compact.`} disabled={view.running}>
              {Math.round(usage.percent)}% ctx
            </button>
          )}
          <button className={`pill ${historyOpen ? "active" : ""}`} onClick={onToggleHistory} title="History: fork or jump to an earlier point">history</button>
        </div>
      )}
      <span className={`conn conn-${connection}`} title={`host ${connection}`} />
      {picking && (
        <div className="model-picker">
          <input autoFocus placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="model-list">
            {shown.map((m) => (
              <button
                key={`${m.provider}/${m.id}`}
                className={model && model.provider === m.provider && model.id === m.id ? "active" : ""}
                onClick={() => {
                  setPicking(false);
                  void onSetModel(m);
                }}
              >
                <span>{m.provider}/{m.id}</span>
                <span className="muted">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : ""}{m.reasoning ? " · reasoning" : ""}{m.vision ? " · vision" : ""}</span>
              </button>
            ))}
            {shown.length === 0 && <p className="muted">No models match.</p>}
          </div>
        </div>
      )}
    </header>
  );
}
