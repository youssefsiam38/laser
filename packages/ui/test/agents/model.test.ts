import { AGENT_RUN_STATUSES } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import {
  agentDefinitionInputOf,
  agentDisplayName,
  agentIssueRoot,
  agentIssuesByField,
  agentKindOf,
  compareRunsNewestFirst,
  defaultAgentDefinitionInput,
  isActiveRun,
  isBuiltinAgent,
  isWorkspaceCwd,
  latestRunForSession,
  RUN_STATUS_TONE,
  runStatusLabel,
  runStatusTone,
  runsForRoot,
  runsForSession,
  sessionAgentName,
  warningsFor,
} from "../../src/agents/index.js";
import { agentEventTone } from "../../src/components/assistant-ui/elements/agent-handoff.js";
import { sessionTitle } from "../../src/runtime/threadList.js";
import { agent, run, sessionState, snapshot, summary, view } from "./fixtures.js";

describe("run status vocabulary", () => {
  it("gives every status a label in the shared vocabulary and a tone", () => {
    const labels = Object.fromEntries(AGENT_RUN_STATUSES.map((status) => [status, runStatusLabel(status)]));
    expect(labels).toEqual({
      queued: "Waiting",
      running: "Working",
      // Live and paused on a question (M13-T45): one word for a row.
      needs_input: "Asking",
      completed: "Done",
      blocked: "Blocked",
      failed: "Failed",
      cancelled: "Ended",
    });
    const tones = Object.fromEntries(AGENT_RUN_STATUSES.map((status) => [status, runStatusTone(status)]));
    expect(tones).toEqual({
      queued: "muted",
      running: "live",
      // Stuck on someone: the warm hue, never the live one.
      needs_input: "attention",
      // Green means happening now, so a finished run is muted (D-154).
      completed: "muted",
      // Ended with a blocker: truthful history, not a live question.
      blocked: "muted",
      failed: "danger",
      cancelled: "muted",
    });
    expect(isActiveRun({ status: "queued" })).toBe(true);
    expect(isActiveRun({ status: "running" })).toBe(true);
    // Paused is not ended: a child asking a question is still going.
    expect(isActiveRun({ status: "needs_input" })).toBe(true);
    for (const status of ["completed", "blocked", "failed", "cancelled"] as const) expect(isActiveRun({ status })).toBe(false);
  });

  it("never paints a run status in the success colour", () => {
    // D-154: green is "happening now" in this app. `ok` stays in the tone
    // vocabulary for genuinely positive confirmations elsewhere, but no run
    // status may reach for it, in the sidebar, the fleet or the live map.
    expect(Object.values(RUN_STATUS_TONE)).not.toContain("ok");
    const kinds = ["agent.completed", "agent.blocked", "agent.failed", "agent.cancelled", "agent.message", "agent.needs_input"] as const;
    expect(kinds.map(agentEventTone)).not.toContain("ok");
  });
});

describe("sessions and kinds", () => {
  const snap = snapshot();

  it("detects the built-in workspaces by directory", () => {
    expect(isWorkspaceCwd("/state/beam", snap)).toBe("beam");
    expect(isWorkspaceCwd("/state/chat", snap)).toBe("chat");
    expect(isWorkspaceCwd("/p", snap)).toBeNull();
    expect(isWorkspaceCwd("/state/beam", null)).toBeNull();
    expect(isWorkspaceCwd(undefined, snap)).toBeNull();
  });

  it("places a session by attribution first, then parentage, then directory", () => {
    expect(agentKindOf(summary({ path: "/p/a", agent: { agentName: "reviewer", kind: "child" } }), snap)).toBe("child");
    expect(agentKindOf(summary({ path: "/p/a", parentPath: "/p/root" }), snap)).toBe("child");
    expect(agentKindOf(summary({ path: "/b", cwd: "/state/beam" }), snap)).toBe("beam");
    expect(agentKindOf(summary({ path: "/c", cwd: "/state/chat" }), snap)).toBe("chat");
    expect(agentKindOf(summary({ path: "/p/a" }), snap)).toBe("root");
    expect(agentKindOf(undefined, snap)).toBe("root");
    // Attribution wins over the directory: a Beam-started child in the Beam workspace is a child.
    expect(agentKindOf(summary({ path: "/b", cwd: "/state/beam", agent: { agentName: "beam", kind: "beam" } }), snap)).toBe("beam");
  });

  it("names the agent a session runs, falling back to the default", () => {
    expect(sessionAgentName(summary({ path: "/p/a", agent: { agentName: "reviewer", kind: "root" } }), snap)).toBe("reviewer");
    expect(sessionAgentName(summary({ path: "/p/a" }), snapshot({ defaultAgent: "reviewer" }))).toBe("reviewer");
    expect(sessionAgentName(summary({ path: "/p/a" }), null)).toBe("default");
    expect(sessionAgentName(undefined, undefined)).toBe("default");
  });

  it("gives the shipped agents product-facing names", () => {
    expect(agentDisplayName("beam")).toBe("Beam");
    expect(agentDisplayName("chat")).toBe("Chat");
    expect(agentDisplayName("namer")).toBe("Namer");
    expect(agentDisplayName("default")).toBe("Default agent");
    expect(agentDisplayName("reviewer")).toBe("reviewer");
    expect(isBuiltinAgent(agent({ name: "beam", kind: "builtin" }))).toBe(true);
    expect(isBuiltinAgent(agent({ name: "default" }))).toBe(false);
    expect(isBuiltinAgent(agent({ name: "reviewer" }))).toBe(false);
  });

  it("titles an unnamed, empty child session by the name its parent gave it", () => {
    const child = summary({ path: "/p/c", agent: { agentName: "reviewer", kind: "child", subagentName: "reviewer-1" } });
    expect(sessionTitle(child)).toBe("reviewer-1");
    expect(sessionTitle({ ...child, name: "Review the diff" })).toBe("Review the diff");
    expect(sessionTitle({ ...child, firstMessage: "Look at packages/ui" })).toBe("Look at packages/ui");
    // The open view carries the attribution before the catalog has scanned the file.
    const v = view({ path: "/p/c", state: sessionState({ path: "/p/c", agent: { agentName: "reviewer", kind: "child", subagentName: "tester-2" } }) });
    expect(sessionTitle(summary({ path: "/p/c" }), v)).toBe("tester-2");
    expect(sessionTitle(summary({ path: "/p/d" }))).toBe("New session");
  });
});

describe("runs", () => {
  const runs = {
    r1: run({ runId: "r1", sessionPath: "/p/a.jsonl", startedAt: "2026-09-08T10:00:00.000Z", status: "completed" }),
    r2: run({ runId: "r2", sessionPath: "/p/a.jsonl", startedAt: "2026-09-08T10:10:00.000Z" }),
    r3: run({ runId: "r3", sessionPath: "/p/b.jsonl", startedAt: "2026-09-08T10:05:00.000Z", rootSessionPath: "/q/root.jsonl" }),
  };

  it("finds the newest run of a session from a record or a list", () => {
    expect(latestRunForSession(runs, "/p/a.jsonl")?.runId).toBe("r2");
    expect(latestRunForSession(Object.values(runs), "/p/a.jsonl")?.runId).toBe("r2");
    expect(latestRunForSession(runs, "/p/none.jsonl")).toBeUndefined();
    expect(runsForSession(runs, "/p/a.jsonl").map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(runsForRoot(runs, "/p/root.jsonl").map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(runsForRoot(runs, "/q/root.jsonl").map((r) => r.runId)).toEqual(["r3"]);
  });

  it("lets a canonical resumed run replace failed history, including timestamp ties", () => {
    const failed = run({
      runId: "run_z",
      sessionPath: "/p/resumed.jsonl",
      status: "failed",
      startedAt: "2026-09-08T10:20:00.000Z",
      updatedAt: "2026-09-08T10:21:00.000Z",
    });
    const working = run({
      runId: "run_a",
      sessionPath: failed.sessionPath,
      status: "running",
      startedAt: failed.startedAt,
      // Active wins a start-time tie even before its first update lands.
      updatedAt: "2026-09-08T10:20:00.000Z",
    });
    for (const candidates of [[failed, working], [working, failed]]) {
      expect(latestRunForSession(candidates, failed.sessionPath)).toBe(working);
    }

    const completed = { ...working, runId: "run_0", status: "completed" as const, updatedAt: "2026-09-08T10:22:00.000Z" };
    expect(latestRunForSession([failed, completed], failed.sessionPath)).toBe(completed);
  });

  it("stands a session on the run that can still act while a newer successor only waits behind it", () => {
    // Terminal-pending (M13-T98): the old run's completion is declared but its
    // invocation is still executing, and the one successor reserved behind it
    // is queued. The worker's `liveness` picks the executing run; so does this.
    const unwinding = run({ runId: "run_old", sessionPath: "/p/pending.jsonl", status: "running", startedAt: "2026-09-08T10:30:00.000Z", updatedAt: "2026-09-08T10:31:30.000Z" });
    const waiting = run({ runId: "run_next", sessionPath: unwinding.sessionPath, status: "queued", startedAt: "2026-09-08T10:31:00.000Z", updatedAt: "2026-09-08T10:31:00.000Z" });
    for (const candidates of [[unwinding, waiting], [waiting, unwinding]]) {
      expect(latestRunForSession(candidates, unwinding.sessionPath)).toBe(unwinding);
      // Creation order still ends on the run that stands for the session.
      expect(runsForSession(candidates, unwinding.sessionPath).at(-1)).toBe(unwinding);
    }
    expect(compareRunsNewestFirst(unwinding, waiting)).toBeLessThan(0);
    expect(compareRunsNewestFirst(waiting, unwinding)).toBeGreaterThan(0);
    const asking = { ...unwinding, status: "needs_input" as const };
    expect(latestRunForSession([waiting, asking], unwinding.sessionPath)).toBe(asking);
    // A successor the person stopped is history; the executing run still stands.
    const stopped = { ...waiting, status: "cancelled" as const, endedAt: "2026-09-08T10:31:20.000Z", updatedAt: "2026-09-08T10:31:20.000Z" };
    expect(latestRunForSession([stopped, unwinding], unwinding.sessionPath)).toBe(unwinding);
    // Once the old run has truly ended, the successor stands — waiting or working.
    const ended = { ...unwinding, status: "completed" as const, endedAt: "2026-09-08T10:32:00.000Z", updatedAt: "2026-09-08T10:32:00.000Z" };
    expect(latestRunForSession([ended, waiting], unwinding.sessionPath)).toBe(waiting);
    expect(latestRunForSession([ended, { ...waiting, status: "running" as const }], unwinding.sessionPath)?.runId).toBe("run_next");
    // D-189 stands: a newer active run outranks historic failures, and a
    // finished Blocked is neutral history like any other ended run.
    const failed = { ...unwinding, runId: "run_failed", status: "failed" as const, endedAt: "2026-09-08T10:30:30.000Z" };
    const resumed = { ...waiting, runId: "run_resumed", status: "running" as const };
    expect(latestRunForSession([resumed, failed], unwinding.sessionPath)).toBe(resumed);
    const blocked = { ...unwinding, status: "blocked" as const, endedAt: "2026-09-08T10:32:00.000Z", updatedAt: "2026-09-08T10:32:00.000Z" };
    expect(latestRunForSession([blocked, waiting], unwinding.sessionPath)).toBe(waiting);
  });
});

describe("definitions, warnings and issues", () => {
  it("builds a blank custom agent that starts nothing and lists nothing", () => {
    // The two have to agree: a definition that starts nothing and names agents
    // anyway is one the host refuses, so a blank form would open unsaveable.
    // The editor's delegation toggle fills the list when it is turned on.
    const input = defaultAgentDefinitionInput(snapshot());
    expect(input).toEqual({
      name: "",
      description: "",
      instructions: "",
      engineInstructions: false,
      model: null,
      thinkingLevel: null,
      supportsSubagents: false,
      allowedAgents: [],
      scopedSkills: false,
      skills: [],
    });
    expect(defaultAgentDefinitionInput().allowedAgents).toEqual([]);
    expect("kind" in input).toBe(false);
  });

  it("turns a definition into its editable input without the read-only fields", () => {
    const definition = agent({ name: "reviewer", skills: [{ name: "review", path: "/skills/review/SKILL.md", scope: "project" }] });
    const input = agentDefinitionInputOf(definition);
    expect(input).not.toHaveProperty("kind");
    expect(input).not.toHaveProperty("createdAt");
    expect(input.skills).toEqual(definition.skills);
    expect(input.skills).not.toBe(definition.skills);
  });

  it("lists a definition's warnings oldest first and shares one empty list", () => {
    const snap = snapshot({
      warnings: [
        { agentName: "reviewer", field: "model", target: "gpt-9", message: "Model is no longer offered.", since: "2026-09-08T10:00:00.000Z" },
        { agentName: "other", field: "skills", message: "Skill file moved.", since: "2026-09-08T09:00:00.000Z" },
        { agentName: "reviewer", field: "skills", target: "review", message: "Skill file changed.", since: "2026-09-08T08:00:00.000Z" },
      ],
    });
    expect(warningsFor(snap, "reviewer").map((w) => w.field)).toEqual(["skills", "model"]);
    expect(warningsFor(snap, "nobody")).toBe(warningsFor(null, "nobody"));
    expect(warningsFor(snap, "nobody")).toHaveLength(0);
  });

  it("groups issues by the exact field and by the form field that owns it", () => {
    const grouped = agentIssuesByField([
      { field: "name", message: "Use lower-case letters, digits and hyphens." },
      { field: "skills[2]", message: "Skill file not found." },
      { field: "skills[0]", message: "Skill file changed since it was chosen." },
      { field: "allowedAgents", message: "reviewer cannot start itself." },
    ]);
    expect(grouped.any).toBe(true);
    expect(grouped.exact["skills[2]"]).toEqual(["Skill file not found."]);
    expect(grouped.root.skills).toEqual(["Skill file not found.", "Skill file changed since it was chosen."]);
    expect(grouped.root.name).toEqual(["Use lower-case letters, digits and hyphens."]);
    expect(agentIssueRoot("skills[2]")).toBe("skills");
    expect(agentIssueRoot("skills[2].path")).toBe("skills");
    expect(agentIssueRoot("model.provider")).toBe("model");
    expect(agentIssueRoot("name")).toBe("name");
    expect(agentIssuesByField([]).any).toBe(false);
  });
});
