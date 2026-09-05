/**
 * The Router's "unwritten session" bookkeeping (integration seam for M9).
 *
 * Pi writes a session file lazily, so a session created by `session/new` is
 * invisible to the catalog until its first persisted message. The Router keeps
 * a stub so the sidebar and `piorbit sessions` show it immediately. The stub is
 * a small state machine with three exits — catalog catches up, worker lets go,
 * or the filter excludes it — and getting any of them wrong leaves a ghost
 * session in the list forever, which is exactly the kind of bug a test is the
 * cheapest way to rule out.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionState, SessionSummary } from "@piorbit/protocol";
import { AttentionTracker } from "../src/attention.js";
import { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";

const CWD_A = "/projects/a";
const CWD_B = "/projects/b";
const PATH_A = "/sessions/new-a.jsonl";

function state(path: string, cwd: string): SessionState {
  return {
    path,
    id: "id-of-a",
    cwd,
    model: null,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

/** A Router with fakes for everything but the piece under test. */
function harness(options: { catalogRows?: SessionSummary[]; open?: Record<string, string[]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "piorbit-router-"));
  const catalogRows = options.catalogRows ?? [];
  const open = options.open ?? { [CWD_A]: [PATH_A] };

  const catalog = {
    list: (cwd?: string) =>
      (cwd === undefined ? catalogRows : catalogRows.filter((row) => row.cwd === cwd)).map((row) => ({ ...row, size: 1 })),
    get: (path: string) => catalogRows.find((row) => row.path === path),
    cwdOf: (path: string) => catalogRows.find((row) => row.path === path)?.cwd,
  } as unknown as SessionCatalog;

  const pool = {
    openSessions: (cwd: string) => open[cwd] ?? [],
    cwdOfSession: () => undefined,
  } as unknown as WorkerPool;

  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir });
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2) });

  // The Router only records a stub from inside `dispatch`; reach the private
  // recorder the same way `session/new` does, without standing up a worker.
  const note = (s: SessionState) => (router as unknown as { noteUnwritten(s: SessionState): void }).noteUnwritten(s);

  return {
    router,
    note,
    catalogRows,
    open,
    cleanup: () => {
      projects.close();
      attention.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("Router · sessions not yet on disk", () => {
  it("lists a session the worker holds but Pi has not written", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    expect(h.router.sessions().map((s) => s.path)).toEqual([PATH_A]);
    expect(h.router.sessions(CWD_A).map((s) => s.path)).toEqual([PATH_A]);
    h.cleanup();
  });

  it("honours the cwd filter", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    expect(h.router.sessions(CWD_B)).toEqual([]);
    // Filtering it out must not drop it: it is still open in its own project.
    expect(h.router.sessions(CWD_A).map((s) => s.path)).toEqual([PATH_A]);
    h.cleanup();
  });

  it("drops the stub once the catalog sees the real file, without duplicating it", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    h.catalogRows.push({
      path: PATH_A,
      id: "id-of-a",
      cwd: CWD_A,
      createdAt: "2026-01-01T00:00:00Z",
      modifiedAt: "2026-01-01T00:00:01Z",
      messageCount: 2,
      firstMessage: "hello",
    });
    const rows = h.router.sessions();
    expect(rows).toHaveLength(1);
    // The catalog's row wins: it has the real message count and first message.
    expect(rows[0]).toMatchObject({ messageCount: 2, firstMessage: "hello" });
    h.catalogRows.length = 0;
    // Forgotten for good, so a later catalog eviction cannot resurrect a ghost.
    expect(h.router.sessions()).toEqual([]);
    h.cleanup();
  });

  it("drops the stub when the worker closes the session without ever writing it", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    expect(h.router.sessions()).toHaveLength(1);
    h.open[CWD_A] = [];
    expect(h.router.sessions()).toEqual([]);
    h.cleanup();
  });

  it("never shadows a session the catalog already knows", () => {
    const h = harness({
      catalogRows: [
        {
          path: PATH_A,
          id: "id-of-a",
          cwd: CWD_A,
          createdAt: "2026-01-01T00:00:00Z",
          modifiedAt: "2026-01-01T00:00:01Z",
          messageCount: 5,
        },
      ],
    });
    h.note(state(PATH_A, CWD_A));
    const rows = h.router.sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageCount).toBe(5);
    h.cleanup();
  });
});
