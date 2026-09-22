/**
 * A research loop is a Command (M21-T26 · `docs/research-phase.md`).
 *
 * The contract line these proofs answer to is "the budget is visible in the
 * fleet row and the Research header", and its companion "progress is the
 * question tree's states and the budget spent; no percentages, no invented
 * ETA". So: one row under the conversation the loop runs in, published before
 * the call it describes, a line that is the phase plus the counted spend and
 * nothing else, a Stop that reaches the run from that row, and a terminal row
 * whose reason is what really ended it.
 *
 * Nothing here touches an adapter, a network or a host: the "tool call" is an
 * inert function this file controls, so every assertion is about an exact
 * point in a run's lifetime rather than about a timeout.
 */
import { describe, expect, it } from "vitest";
import { RESEARCH_BUDGET_DEFAULTS, isResearchFleetTaskId, researchFleetTaskId, researchRunIdOf, type BackgroundTask } from "@lasercode/protocol";
import { ResearchLedger } from "../../src/research/budget.js";
import { RESEARCH_ROW_ACTIVITY_MAX } from "../../src/research/command.js";
import { RESEARCH_RUNS_KEPT, ResearchRunService } from "../../src/research/runs.js";

const PATH = "/tmp/research-fleet/s1.jsonl";

interface Published {
  path: string;
  task: BackgroundTask;
}

function harness(
  options: {
    holds?: (path: string) => boolean;
    budget?: Partial<typeof RESEARCH_BUDGET_DEFAULTS>;
    throwOnPublish?: boolean;
    now?: () => number;
  } = {},
) {
  const rows: Published[] = [];
  const notes: string[] = [];
  let aborted = 0;
  const ledger = new ResearchLedger({
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const service = new ResearchRunService({
    holdsSession: options.holds ?? (() => true),
    publishTask: (path, task) => {
      if (options.throwOnPublish === true) throw new Error("the observer is somebody else's code");
      rows.push({ path, task });
    },
    log: (line) => notes.push(line),
    ...(options.now ? { now: options.now } : {}),
  });
  /** One research tool call, with the answer this file decides. */
  const during = async <T>(tool: string, call: () => Promise<T>, path = PATH): Promise<T> =>
    service.during({ sessionPath: path, tool, ledger, abort: () => (aborted += 1) }, call);
  /** A call this file holds open, so a row can be read while it runs. */
  const deferred = (): { promise: Promise<Record<string, unknown>>; settle: (value?: Record<string, unknown>) => void } => {
    let settle: (value: Record<string, unknown>) => void = () => {};
    const promise = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve;
    });
    return { promise, settle: (value = {}) => settle(value) };
  };
  const last = (): BackgroundTask => rows.at(-1)!.task;
  const runIdOf = (): string => researchRunIdOf(rows[0]!.task.id);
  return { service, ledger, rows, notes, during, deferred, last, runIdOf, aborted: () => aborted };
}

/** A turn of the event loop, so a released call's `finally` has run. */
const turn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("the fleet row of a research loop", () => {
  it("is published before the call it describes, and says the phase and the counted budget", async () => {
    const h = harness();
    const call = h.deferred();
    const running = h.during("search_sources", () => call.promise);
    // The row exists while the call is still in the air: the publication is
    // before the work, not after it — and once, not once per place the run
    // publishes from.
    expect(h.rows).toHaveLength(1);
    const first = h.rows[0]!;
    expect(first.path, "under the conversation the loop is running in").toBe(PATH);
    expect(isResearchFleetTaskId(first.task.id)).toBe(true);
    expect(first.task.sessionPath).toBe(PATH);
    expect(first.task.status).toBe("running");
    expect(first.task.origin).toBe("background");
    expect(first.task.outputBytes, "the row is not a log").toBe(0);
    expect(first.task.endedAt, "nothing has ended").toBeUndefined();
    expect(first.task.activity).toBe("Searching sources · 0/24 searches · 0/32 reads · 0 B of 4.0 MB · 0s");
    expect(first.task.activity!.length).toBeLessThanOrEqual(RESEARCH_ROW_ACTIVITY_MAX);
    expect(first.task.activity, "counted units, never a share of an unknown total").not.toContain("%");

    // The step is the progress: a different tool is a different phase, and a
    // phase change is never throttled away.
    call.settle({});
    await running;
    h.ledger.chargeSearch("web", "pdf libraries for node");
    const read = h.deferred();
    const reading = h.during("read_source", () => read.promise);
    expect(h.last().activity).toBe("Reading a source · 1/24 searches · 0/32 reads · 0 B of 4.0 MB · 0s");
    read.settle({});
    await reading;

    // And nothing on any row names a question, a query or a source: the row
    // is built from an enum and four counts.
    const text = JSON.stringify(h.rows);
    expect(text).not.toContain("pdf libraries");
    expect(text).not.toContain("http");
  });

  it("takes no row for a conversation this worker is not holding, and still runs the call", async () => {
    const h = harness({ holds: () => false });
    await expect(h.during("search_sources", async () => ({ hits: [] }))).resolves.toEqual({ hits: [] });
    expect(h.rows, "a row under a path nobody serves is a row nobody can find").toHaveLength(0);
    expect(h.service.unsettledWork(), "and no run is held for it either").toEqual([]);
  });

  it("is one run for one loop, whatever the loop calls", async () => {
    const h = harness();
    for (const tool of ["search_sources", "read_source", "record_finding", "resolve_question"]) {
      await h.during(tool, async () => ({}));
    }
    const ids = new Set(h.rows.map((row) => row.task.id));
    expect(ids.size, "four calls, one Command").toBe(1);
  });
});

describe("a person's Stop, from the row", () => {
  it("ends the loop, keeps what it recorded, and refuses what comes next", async () => {
    const h = harness();
    await h.during("record_finding", async () => ({ findingId: "f1" }));
    const runId = h.runIdOf();

    expect(h.service.stopByTaskId(researchFleetTaskId(runId)), "this worker holds that row").toBe(true);
    const ended = h.last();
    expect(ended.status).toBe("stopped");
    expect(ended.endedAt).toBeDefined();
    expect(ended.terminalReason).toContain("You stopped it");
    expect(ended.terminalReason, "nothing recorded is deleted, and the row says so").toContain("already recorded are kept");
    expect(ended.terminalReason, "and it says what the run spent").toContain("Spent: 0/24 searches");
    expect(h.aborted(), "what the adapters were doing is cut").toBe(1);

    // The loop's next call is refused with the sentence that tells the model
    // to report what it has: the run ends on a refusal it can report.
    expect(() => h.ledger.chargeSearch("web", "anything")).toThrow(/stopped/i);
    expect(h.ledger.stopped()).toContain("you stopped it");

    // A row id nobody here holds is said so, and one that is held stays held.
    expect(h.service.stopByTaskId("research-res_9999")).toBe(false);
    expect(h.service.stopByTaskId("verify-ver_0001"), "another Command's row is not answered here").toBe(false);
    expect(h.service.stopByTaskId(researchFleetTaskId(runId)), "a second stop still finds the run").toBe(true);
    expect(h.service.stop({ runId }), "and changes nothing about it").toEqual({ stopped: false });

    // The loop is over, so a call that arrives after it does not open a
    // second row for a Command that never started.
    const before = h.rows.length;
    await h.during("search_sources", async () => ({})).catch(() => undefined);
    expect(h.rows).toHaveLength(before);
  });

  it("leaves the row running while the call in flight finishes, then settles it", async () => {
    const h = harness();
    const call = h.deferred();
    const running = h.during("record_finding", () => call.promise);
    const runId = h.runIdOf();

    expect(h.service.stopByTaskId(researchFleetTaskId(runId))).toBe(true);
    const winding = h.last();
    expect(winding.status, "the write is still in the air, so the row is still running").toBe("running");
    expect(winding.endedAt).toBeUndefined();
    expect(winding.activity).toContain("Stopping");
    expect(h.service.unsettledWork(), "and this worker still owes that work").toEqual([
      { sessionPath: PATH, taskIds: [researchFleetTaskId(runId)] },
    ]);

    call.settle({});
    await running;
    await turn();
    expect(h.last().status).toBe("stopped");
    expect(h.service.unsettledWork()).toEqual([]);
  });
});

describe("the loop's own endings", () => {
  it("ends when every question is resolved", async () => {
    const h = harness();
    await h.during("resolve_question", async () => ({ questionId: "q1", openQuestions: 0 }));
    await turn();
    const ended = h.last();
    expect(ended.status).toBe("completed");
    expect(ended.terminalReason).toContain("Every question is resolved");
    expect(h.service.unsettledWork()).toEqual([]);
  });

  it("stays running while questions remain, and says how many are left when it ends", async () => {
    const h = harness();
    await h.during("resolve_question", async () => ({ questionId: "q1", openQuestions: 2 }));
    await turn();
    expect(h.last().status, "two questions open is not an ending").toBe("running");
    h.service.turnEnded(PATH);
    const ended = h.last();
    expect(ended.status).toBe("completed");
    expect(ended.terminalReason).toContain("The turn this research ran in ended");
    expect(ended.terminalReason).toContain("2 questions still open");
  });

  it("ends when the budget is spent, with the reason the ledger gives", async () => {
    const h = harness({ budget: { maxBytes: 1024 } });
    await h.during("read_source", async () => {
      h.ledger.chargeBytes(2048);
      return {};
    }).catch(() => undefined);
    await turn();
    const ended = h.last();
    expect(ended.status, "a spent budget is not a failure").toBe("completed");
    expect(ended.terminalReason).toContain("as many bytes as it was given");
    expect(ended.terminalReason).toContain("Spent:");
  });

  it("ends when the turn that was running it ends, and a later turn opens the next run", async () => {
    const h = harness();
    await h.during("search_sources", async () => ({}));
    const first = h.runIdOf();
    h.service.turnEnded(PATH);
    expect(h.last().status).toBe("completed");
    expect(h.last().terminalReason).toContain("The turn this research ran in ended");
    expect(h.service.unsettledWork(), "nothing is left running under a conversation nobody is working in").toEqual([]);

    // A second turn that goes back to the research is the next run, with the
    // same ledger, so the spend a row shows is this research's own total.
    h.ledger.chargeSearch("project", "budget");
    await h.during("search_sources", async () => ({}));
    const second = researchRunIdOf(h.last().id);
    expect(second).not.toBe(first);
    expect(h.last().activity).toContain("1/24 searches");

    // An ending for a run that has already ended changes nothing.
    const rows = h.rows.length;
    h.service.turnEnded(PATH);
    h.service.turnEnded(PATH);
    expect(h.rows.length).toBe(rows + 1);
  });
});

describe("the conversation a run belongs to", () => {
  it("carries the row to its new address on a fork, and never names the old one again", async () => {
    const h = harness();
    const call = h.deferred();
    const running = h.during("search_sources", () => call.promise);
    const moved = "/tmp/research-fleet/s1-forked.jsonl";
    const before = h.rows.length;

    h.service.rekeySession(PATH, moved);
    const after = h.rows.slice(before);
    expect(after.length, "the moved conversation is told about the Command it owns").toBeGreaterThan(0);
    for (const row of after) {
      expect(row.path).toBe(moved);
      expect(row.task.sessionPath).toBe(moved);
    }

    call.settle({});
    await running;
    await turn();
    h.service.turnEnded(moved);
    expect(h.rows.slice(before).every((row) => row.path === moved)).toBe(true);
    expect(h.last().status).toBe("completed");
  });

  it("publishes nothing once that conversation is gone, and still owes the write in flight", async () => {
    const h = harness();
    const call = h.deferred();
    const running = h.during("record_finding", () => call.promise);
    const runId = h.runIdOf();
    const before = h.rows.length;

    h.service.sessionClosed(PATH);
    expect(h.rows.length, "a row under a path no runtime serves would be a ghost the fleet cannot lose").toBe(before);
    expect(h.aborted()).toBe(1);
    expect(h.service.unsettledWork(), "the work is still owed, so this process may not end on it").toEqual([
      { sessionPath: PATH, taskIds: [researchFleetTaskId(runId)] },
    ]);
    expect(h.service.hasUnsettled(PATH)).toBe(true);

    call.settle({});
    await running;
    await turn();
    expect(h.rows.length, "not even its ending is published there").toBe(before);
    expect(h.service.unsettledWork()).toEqual([]);
    expect(h.service.hasUnsettled(PATH)).toBe(false);
  });
});

describe("what the registry keeps", () => {
  it("keeps twenty finished runs and forgets the oldest", async () => {
    const h = harness();
    const ids: string[] = [];
    for (let index = 0; index < RESEARCH_RUNS_KEPT + 2; index += 1) {
      await h.during("resolve_question", async () => ({ openQuestions: 0 }));
      await turn();
      ids.push(researchRunIdOf(h.last().id));
    }
    expect(new Set(ids).size).toBe(RESEARCH_RUNS_KEPT + 2);
    // The two oldest are gone; every one after them is still a run this
    // worker can be asked about.
    expect(h.service.stopByTaskId(researchFleetTaskId(ids[0]!))).toBe(false);
    expect(h.service.stopByTaskId(researchFleetTaskId(ids[1]!))).toBe(false);
    for (const id of ids.slice(2)) {
      expect(h.service.stopByTaskId(researchFleetTaskId(id)), `${id} is still held`).toBe(true);
    }
  });

  it("loses a row to an observer that throws, and never the run", async () => {
    const h = harness({ throwOnPublish: true });
    await h.during("search_sources", async () => ({}));
    h.service.turnEnded(PATH);
    expect(h.rows, "the observer took nothing").toHaveLength(0);
    expect(h.notes.length, "and one bounded line says a row went missing").toBeGreaterThan(0);
    expect(h.notes[0]).toContain("fleet row may be missing");
    expect(h.notes.join(" "), "the error's kind, never its message").not.toContain("somebody else's code");
    expect(h.service.unsettledWork(), "the run settled all the same, so nothing is pinned for ever").toEqual([]);
  });
});
