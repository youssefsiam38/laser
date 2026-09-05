import { useEffect, useState } from "react";
import type { ModelRef, SessionState, ThinkingLevel } from "@piorbit/protocol";
import type { SessionView } from "../store.js";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface Props {
  view: SessionView | undefined;
  connection: "connecting" | "open" | "closed";
  onMenu: () => void;
  onSetModel: (model: SessionState["model"]) => Promise<void>;
  onSetThinking: (level: ThinkingLevel) => Promise<void>;
  onListModels: () => Promise<ModelRef[]>;
}

export function TopBar({ view, connection, onMenu, onSetModel, onSetThinking, onListModels }: Props) {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!picking) return;
    void onListModels().then(setModels);
  }, [picking, onListModels]);

  const model = view?.state.model;
  const shown = models.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
  const usage = view?.state.contextUsage;

  return (
    <header className="topbar">
      <button className="icon-btn hide-desktop" onClick={onMenu} aria-label="Sessions">☰</button>
      <div className="topbar-title" title={view?.path}>
        {view ? (view.title ?? view.state.name ?? view.state.id.slice(0, 8)) : "piorbit"}
        {view && <span className="muted"> · {view.state.cwd.split("/").slice(-1)[0]}</span>}
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
            <span className="pill muted" title={`${usage.tokens ?? "?"} / ${usage.contextWindow} tokens`}>{Math.round(usage.percent)}% ctx</span>
          )}
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
