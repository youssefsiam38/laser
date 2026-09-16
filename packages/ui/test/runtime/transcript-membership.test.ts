import { describe, expect, it } from "vitest";
import type { AgentRun, SessionState } from "@lasercode/protocol";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { releasableTranscriptPaths } from "../../src/runtime/transcript-membership.js";
import type { ViewCacheEnvironment } from "../../src/runtime/view-cache.js";

const CWD = "/p";
const path = (name: string) => `${CWD}/${name}.jsonl`;
const session = (name: string, over: Partial<SessionState> = {}): SessionState => ({
  path: path(name), id: name, cwd: CWD, messageCount: 2, pendingMessageCount: 0,
  isStreaming: false, isCompacting: false, ...over,
} as SessionState);

const open = (state: AppState, name: string, over?: Partial<SessionState>): AppState =>
  reduce(state, { type: "opened", state: session(name, over) });

const environment = (draft?: string, scoped?: string): ViewCacheEnvironment => ({
  scoped: () => scoped ? [scoped] : [],
  hasDraft: (candidate) => candidate === draft,
});

describe("transcript membership reconciliation", () => {
  it("keeps streaming, question, queued, run, draft, unsent and visible holds", () => {
    let state: AppState = { ...initialState, connection: "open" };
    for (const name of ["streaming", "question", "queued", "run", "draft", "unsent", "visible"]) {
      state = open(state, name, name === "streaming" ? { isStreaming: true } : undefined);
    }
    state = reduce(state, { type: "notification", method: "pi/ui/request", params: {
      path: path("question"), id: "q", method: "confirm", title: "Continue?",
    } });
    state = reduce(state, { type: "notification", method: "session/update", params: {
      sessionPath: path("queued"), seq: 1, at: "", update: { kind: "queue_update", steering: ["later"], followUp: [] },
    } });
    const run: AgentRun = {
      runId: "r", sessionPath: path("run"), rootSessionPath: path("run"), agentName: "worker", subagentName: "worker",
      status: "running", origin: "agent", startedAt: "", updatedAt: "", cwd: CWD,
    } as AgentRun;
    state = reduce(state, { type: "agents/run", run });
    state = reduce(state, { type: "optimisticUser", path: path("unsent"), text: "not sent yet", images: [] });
    state = { ...state, current: path("visible") };

    const held = new Set(Object.keys(state.open));
    expect(releasableTranscriptPaths(state, held, new Set(), new Set(), environment(path("draft")))).toEqual([]);
  });

  it("releases the default owner for a scope and attempts a dormant hold only once", () => {
    let state: AppState = { ...initialState, connection: "open" };
    state = open(state, "scope");
    state = open(state, "dormant");
    const held = new Set([path("scope"), path("dormant")]);
    const scoped = environment(undefined, path("scope"));

    expect(releasableTranscriptPaths(state, held, new Set(), new Set(), scoped).sort())
      .toEqual([path("dormant"), path("scope")].sort());
    expect(releasableTranscriptPaths(state, held, new Set(), new Set([path("dormant"), path("scope")]), scoped))
      .toEqual([]);
  });
});
