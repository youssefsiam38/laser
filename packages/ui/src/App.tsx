import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ContentBlock, SessionState, ThinkingLevel, UiDialogResponse } from "@piorbit/protocol";
import { HostClient } from "./client.js";
import { initialState, reduce, type AppState } from "./store.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { Composer } from "./components/Composer.js";
import { Dialogs } from "./components/Dialogs.js";
import { TopBar } from "./components/TopBar.js";
import { History } from "./components/History.js";

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const client = useMemo(
    () =>
      new HostClient({
        onNotification: (method, params) => dispatch({ type: "notification", method, params }),
        onConnection: (s) => dispatch({ type: "connection", state: s }),
      }),
    [],
  );

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions } = await client.request("pi/session/list", {});
      dispatch({ type: "sessions", sessions });
    } catch {
      /* not connected yet */
    }
  }, [client]);

  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  useEffect(() => {
    if (state.connection === "open") void refreshSessions();
  }, [state.connection, refreshSessions]);

  // Pi creates the session file on the first message and renames happen
  // mid-session, so refresh the catalog whenever a session settles and on a
  // slow poll while connected.
  const runningCount = Object.values(state.open).filter((v) => v.running).length;
  useEffect(() => {
    if (state.connection === "open") void refreshSessions();
  }, [runningCount, state.connection, refreshSessions]);
  useEffect(() => {
    if (state.connection !== "open") return;
    const t = setInterval(() => void refreshSessions(), 20_000);
    return () => clearInterval(t);
  }, [state.connection, refreshSessions]);

  const openSession = useCallback(
    async (path: string) => {
      const view = stateRef.current.open[path];
      const { state: s } = await client.request("session/load", { path, fromSeq: view?.lastSeq ?? 0 });
      client.track(path, view?.lastSeq ?? 0);
      dispatch({ type: "opened", state: s });
      if (!view?.hydrated) {
        const { entries } = await client.request("pi/session/entries", { path });
        dispatch({ type: "hydrate", path, entries });
      }
      setSidebarOpen(false);
    },
    [client],
  );

  const newSession = useCallback(
    async (cwd: string) => {
      const { state: s } = await client.request("session/new", { cwd });
      client.track(s.path, 0);
      dispatch({ type: "opened", state: s });
      dispatch({ type: "hydrate", path: s.path, entries: [] });
      setSidebarOpen(false);
      void refreshSessions();
    },
    [client, refreshSessions],
  );

  const current = state.current ? state.open[state.current] : undefined;
  const currentPath = current?.path;

  const send = useCallback(
    async (content: ContentBlock[], behavior: "prompt" | "steer" | "followUp") => {
      if (!currentPath) return;
      const text = content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
      const images = content.filter((c) => c.type === "image").length;
      if (behavior === "prompt") {
        dispatch({ type: "optimisticUser", path: currentPath, text, images });
        const r = await client.request("session/prompt", { path: currentPath, content });
        if (!r.accepted) await client.request("pi/session/steer", { path: currentPath, content });
      } else if (behavior === "steer") {
        await client.request("pi/session/steer", { path: currentPath, content });
      } else {
        await client.request("pi/session/follow_up", { path: currentPath, content });
      }
    },
    [client, currentPath],
  );

  const abort = useCallback(async () => {
    if (currentPath) await client.request("session/cancel", { path: currentPath });
  }, [client, currentPath]);

  const answerDialog = useCallback(
    async (response: UiDialogResponse) => {
      dispatch({ type: "dialogAnswered", id: response.id });
      await client.request("pi/ui/response", response);
    },
    [client],
  );

  const setModel = useCallback(
    async (model: SessionState["model"]) => {
      if (!currentPath || !model) return;
      const { state: s } = await client.request("pi/model/set", { path: currentPath, model: { provider: model.provider, id: model.id } });
      dispatch({ type: "opened", state: s });
    },
    [client, currentPath],
  );

  const setThinking = useCallback(
    async (level: ThinkingLevel) => {
      if (!currentPath) return;
      const { state: s } = await client.request("pi/thinking/set", { path: currentPath, level });
      dispatch({ type: "opened", state: s });
    },
    [client, currentPath],
  );

  const listModels = useCallback(async () => {
    if (!currentPath) return [];
    const { models } = await client.request("pi/model/list", { path: currentPath });
    return models;
  }, [client, currentPath]);

  const rename = useCallback(
    async (name: string) => {
      if (!currentPath) return;
      await client.request("pi/session/rename", { path: currentPath, name });
      void refreshSessions();
    },
    [client, currentPath, refreshSessions],
  );

  const compact = useCallback(async () => {
    if (currentPath) await client.request("pi/session/compact", { path: currentPath });
  }, [client, currentPath]);

  const refreshEntries = useCallback(async () => {
    if (!currentPath) return;
    const { entries } = await client.request("pi/session/entries", { path: currentPath });
    dispatch({ type: "entries", path: currentPath, entries });
  }, [client, currentPath]);

  const fork = useCallback(
    async (entryId: string) => {
      if (!currentPath) return;
      const { state: s } = await client.request("pi/session/fork", { path: currentPath, entryId });
      client.untrack(currentPath);
      client.track(s.path, 0);
      dispatch({ type: "forked", from: currentPath, state: s });
      const { entries } = await client.request("pi/session/entries", { path: s.path });
      dispatch({ type: "hydrate", path: s.path, entries });
      void refreshSessions();
    },
    [client, currentPath, refreshSessions],
  );

  const jump = useCallback(
    async (entryId: string) => {
      if (!currentPath) return;
      await client.request("pi/session/navigate", { path: currentPath, entryId });
      const { entries } = await client.request("pi/session/entries", { path: currentPath });
      dispatch({ type: "hydrate", path: currentPath, entries });
    },
    [client, currentPath],
  );

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : ""} ${historyOpen && current ? "history-open" : ""}`}>
      <Sidebar
        sessions={state.sessions}
        open={state.open}
        current={state.current}
        connection={state.connection}
        onOpen={openSession}
        onNew={newSession}
        onSelect={(path) => {
          dispatch({ type: "select", path });
          setSidebarOpen(false);
        }}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main">
        <TopBar
          view={current}
          connection={state.connection}
          historyOpen={historyOpen}
          onMenu={() => setSidebarOpen((v) => !v)}
          onSetModel={setModel}
          onSetThinking={setThinking}
          onListModels={listModels}
          onRename={rename}
          onCompact={compact}
          onToggleHistory={() => setHistoryOpen((v) => !v)}
        />
        {current ? (
          <>
            <Transcript view={current} />
            <Composer view={current} onSend={send} onAbort={abort} />
          </>
        ) : (
          <div className="empty">
            <h1>piorbit</h1>
            <p>Pick a session on the left, or start a new one in a project.</p>
          </div>
        )}
      </main>
      {historyOpen && current && <History view={current} onRefresh={refreshEntries} onFork={fork} onJump={jump} onClose={() => setHistoryOpen(false)} />}
      {current && <Dialogs view={current} onAnswer={answerDialog} />}
      <div className="toasts">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.level}`} onClick={() => dispatch({ type: "dismissToast", id: t.id })}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
