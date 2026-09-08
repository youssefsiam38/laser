# Pi, pi-subagents, and Laser

## Comprehensive technical reference and source material

> **Version scope:** this guide describes the exact runtime bundled by this
> repository: `@earendil-works/pi-coding-agent` **0.85.0** and
> `pi-subagents` **0.65.1**, plus the Goal interaction with
> `@narumitw/pi-goal` **0.54.4**. These are exact pins in the worker and Goal
> wrapper packages. Later releases may differ.
>
> **Names:** the coding agent is **Pi**, not “Py.” The desktop product is
> **Laser**, not “Lazer.”
>
> **Source basis:** Pi's installed documentation and SDK, pi-subagents'
> installed documentation, schemas, built-in agent definitions, and runtime
> source, pi-goal's documentation and lifecycle source, plus Laser's
> architecture and implementation. Pi's frozen
> `examples/extensions/subagent/` example is deliberately excluded:
> Laser uses the maintained `pi-subagents` package.

---

## Executive overview

Most coding-agent products begin with a chat box. Pi begins one layer
lower: with an agent loop you can actually shape.

pi-subagents does not replace that loop. It creates more Pi
sessions, gives them roles, coordinates them, watches them, and returns their
work to the parent.

Laser takes the same machinery and turns it into a desktop and
phone experience. Pi owns the reasoning loop. pi-subagents owns delegation.
Laser owns the experience: sessions, run trees, panels, controls, themes,
remote access, and product language.

The key distinction is:

1. **Pi is the engine.**
2. **pi-subagents is an orchestration extension for Pi.**
3. **Laser is the product built around the engine and extension.**

---

# Part I — What Pi is

## A small agent core, not a prescribed workflow

Pi is a coding-agent CLI and TypeScript SDK. Its central job is to
run a model/tool loop:

1. accept a user message;
2. send the current conversation and available tools to a model;
3. execute requested tools;
4. feed tool results back to the model;
5. continue until the model finishes, the user interrupts, or the run fails.

The built-in coding tools are `read`, `bash`, `edit`, `write`, `grep`,
`find`, and `ls`. A session can activate only a subset.

Pi intentionally does **not** prescribe a built-in planner, todo system,
subagent system, MCP stack, or background-shell architecture. Those behaviors
come from extensions and packages. That is why pi-subagents can be deep without
forcing every Pi user into one orchestration model.

### Pi's main layers

| Layer | Responsibility |
| --- | --- |
| Model runtime | Provider/model registry, authentication, streaming responses, usage |
| Agent loop | Messages, tool calls, steering, follow-ups, aborts |
| `AgentSession` | Conversation state, persistence, branching, compaction, events |
| `AgentSessionRuntime` | Replacing the active session on new, load, fork, or switch |
| Resource loader | Extensions, skills, prompt templates, themes, context files |
| Modes | Interactive terminal UI, print mode, RPC mode, embeddable SDK |

### The two objects that matter most

`AgentSession` is the live conversation. It exposes the operations
that an interface needs:

- `prompt()` starts a turn;
- `steer()` injects guidance into the active turn;
- `followUp()` queues a message after the current turn;
- `abort()` cancels active generation;
- `setModel()` and `setThinkingLevel()` change inference;
- `compact()` reduces context while preserving the conversation;
- session-tree operations branch or navigate history;
- `subscribe()` emits model, message, tool, and lifecycle events.

`AgentSessionRuntime` owns session replacement. Loading another transcript,
forking, or starting fresh changes the live `AgentSession`; integrations must
rebind event listeners and UI state to the replacement.

### Literal SDK sketch

```ts
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: "/work/acme",
  sessionManager: SessionManager.create("/work/acme"),
});

const unsubscribe = session.subscribe((event) => {
  process.stdout.write(JSON.stringify(event) + "\n");
});

await session.prompt("Find the failing test and explain the root cause.");
await session.followUp("Now propose the smallest safe fix.");

unsubscribe();
```

This is an embedding example, not Laser source. Laser uses the more complete
`createAgentSessionRuntime()` service path described later.

### Best use scenario

Use Pi directly when you want:

- a focused coding agent in a terminal;
- a programmable SDK session inside another application;
- exact control over tools and extensions;
- durable, branchable JSONL session history;
- a minimal core whose workflow policy lives outside the core.

---

## Sessions are trees, not disposable chat buffers

A Pi session is persisted as append-only JSONL. The history can
branch. You can navigate to an earlier entry, fork into a new session, compact
old context, rename a session, export it, or share it.

This matters to pi-subagents because a child can start in two fundamentally
different ways:

- **fresh:** a clean Pi session with only deliberately assembled context;
- **fork:** a real branch of the parent's persisted Pi session.

A fork is not a prose summary. It preserves the selected session history and
parent relationship. Explicit fork mode requires a persisted parent session and
a current leaf. If those are unavailable, an explicit fork fails. An implicit
agent or global fork preference may fall back to fresh.

Pi also supports two queues while a response is active:

- **steering messages** affect the active turn at the next safe boundary;
- **follow-up messages** wait until the current turn ends.

That same distinction appears in pi-subagents control.

### Best use scenario

Use a session fork when the child must understand decisions already made in a
long conversation. Use a fresh session when independence, a clean review, or
lower context cost matters more.

---

## Pi's resource system

Pi is extended through resources:

| Resource | What it contributes |
| --- | --- |
| Extension | Tools, commands, events, UI, providers, renderers, runtime behavior |
| Skill | Instructions and supporting files loaded for a task |
| Prompt template | Reusable slash-invoked prompt |
| Context file | Project or user instructions injected into context |
| Theme | Terminal visual tokens |
| Package | A distributable bundle of any of the above |

Extensions can:

- subscribe to startup, session, agent, model, tool, input, and shutdown events;
- register or replace tools;
- register slash commands, shortcuts, flags, providers, renderers, and markdown
  transforms;
- send assistant or user messages;
- append durable custom entries;
- inspect or change active tools, model, and thinking level;
- execute subprocesses;
- request dialogs, widgets, status, footers, custom components, or editors when
  a UI is present;
- coordinate in process through `pi.events`.

That last item is central. pi-subagents exposes a versioned event-bus API, and
Laser's companion extension talks to it inside the worker process.

### Literal extension sketch

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "project_summary",
    label: "Project summary",
    description: "Summarize the current project.",
    parameters: Type.Object({ focus: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return {
        content: [{
          type: "text",
          text: `Summarize ${ctx.cwd} with focus on ${params.focus}`,
        }],
        details: {},
      };
    },
  });
}
```

---

# Part II — What pi-subagents adds

## Delegation is another Pi session

pi-subagents registers a model-callable tool named `subagent`. A
parent Pi session can use it to launch one child or a scripted workflow of
children.

Native children are real Pi `AgentSession` instances:

- a foreground child runs inside the parent process;
- a background child runs inside a detached runner process;
- the detached runner imports Pi and creates an `AgentSession`; it does not
  shell out to the `pi` CLI;
- both paths observe the child session event stream directly.

### Foreground versus background

| Property | Foreground, `async: false` | Background, usually default |
| --- | --- | --- |
| Parent waits | Yes | No |
| Process | Parent Pi process | Detached runner process |
| Live chat card | Rich streamed card | Launch receipt plus fleet/status surfaces |
| Survives parent turn | Child keeps parent blocked | Yes |
| Ambient parent extensions | Never copied automatically | Loaded in runner unless restricted |
| MCP/provider extension use | Only explicitly safe child setup | Supported through runner-loaded extensions |
| Detach | Optional shortcut, remains in parent process | Already detached |
| Single-file Pi binary | Supported | Not supported; npm package runtime is required |

Foreground children do not load ambient parent extensions because doing so
would start duplicate copies inside the same process. Background runners can
load ambient/provider extensions, subject to the agent definition and capability
ceiling.

### Literal single-child calls

Ask a fast scout and block until it finishes:

```js
subagent({
  agent: "scout",
  task: "Map the authentication request path. Return entry points, key types, and likely edit locations.",
  async: false,
  context: "fresh"
})
```

Start an implementation in the background:

```js
subagent({
  agent: "worker",
  task: "Implement the validated cache invalidation fix and run the focused tests.",
  async: true,
  context: "fork",
  acceptance: {
    level: "checked",
    evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"]
  }
})
```

Run a clean independent review:

```js
subagent({
  agent: "reviewer",
  task: "Review the current diff for correctness and regressions. Report only evidence-backed findings.",
  async: false,
  context: "fresh"
})
```

### Best use scenario

- **Foreground:** the parent cannot make a sound next decision without the
  answer.
- **Background:** work is independent and the parent can continue.
- **Fresh:** review, narrow research, or clean-room verification.
- **Fork:** continuity with prior decisions is essential.

---

## The built-in roles

Roles are Markdown agent profiles with YAML frontmatter and a
system prompt. They select tools, context, thinking, output, and behavior.

### Native Pi roles

| Role | Default character | Best use |
| --- | --- | --- |
| `scout` | Fast, low-thinking codebase reconnaissance; produces `context.md` | Locate entry points and compress context before implementation |
| `researcher` | Web-focused research; produces `research.md` | Current docs, standards, comparisons, evidence gathering |
| `worker` | File-writing implementer with validation discipline | A bounded, already-decided code change |
| `reviewer` | High-thinking, read-only evidence-based reviewer | Diff, plan, solution, PR, or codebase-health review |
| `oracle` | High-context, fork-default decision-consistency advisor | Detect drift, contradictions, and hidden assumptions |
| `delegate` | Lightweight general-purpose child inheriting the parent model | Work that does not fit a specialist role |

`advisor` is an alias for `oracle`.

The researcher expects web tools supplied by a compatible extension such as
`pi-web-access`. A role naming a tool does not magically install its provider.

### External CLI profiles

| Profile | Mode |
| --- | --- |
| `codex-exec` | Read-only one-shot Codex CLI analysis |
| `codex-exec-writer` | Codex CLI with workspace-write sandbox |
| `claude-code` | Read-only/no-tools Claude Code analysis |
| `claude-code-writer` | Claude Code with Read, Write, Edit, Glob, and Grep |
| `cursor-agent` | Read-only Cursor Agent ask mode |
| `cursor-agent-writer` | Cursor Agent writer mode |

External CLI profiles are async-only adapters. They require the named local CLI
and its authentication. They do not gain native Pi model selection, structured
output, fork context, native tools, skills, fallback models, nested subagents,
tool budgets, acceptance machinery, steering, or resume. They support launch,
status/log observation, timeout, and stop according to the adapter.

### A practical role sequence

The package's strongest general pattern is:

1. clarify the contract;
2. scout the relevant code;
3. let one worker own the mutation;
4. run fresh reviewers;
5. send concrete findings back to the same worker;
6. verify acceptance evidence.

This preserves one-writer ownership while still getting parallel scrutiny.

---

## Creating and overriding agents

Agent discovery precedence is:

1. built-ins;
2. installed package agents;
3. extra configured scan directories;
4. user agents under `~/.pi/agent/agents/**/*.md`;
5. project agents under `.pi/agents/**/*.md`.

Higher-precedence definitions win name collisions. A package-qualified name can
preserve access to a shadowed package agent.

> **Laser boundary:** these paths describe upstream Pi and pi-subagents. Laser
> does not treat a project's `.pi` directory as Laser configuration. Laser
> loads reviewed features and validated `.laser` settings instead.

### Literal custom agent

```md
---
name: migration-reviewer
description: Reviews database migrations without modifying files
aliases: schema-review
tools: read, grep, find, ls
excludeTools: bash
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritGlobalContext: false
inheritSkills: false
defaultContext: fresh
defaultProgress: true
timeoutMs: 900000
---

Review the requested migration and its rollback path.

Check locking, data preservation, compatibility during rolling deploys,
and whether the stated validation proves the migration safe.

Return evidence-backed findings ordered by severity.
```

### Agent frontmatter feature inventory

| Field | Purpose |
| --- | --- |
| `name`, `package`, `description`, `aliases` | Identity and discovery |
| `tools`, `excludeTools` | Explicit tool allowlist and denylist |
| `allowNestedSubagents` | Permit the child-safe nested subagent tool |
| `extensions`, `subagentOnlyExtensions` | Select normal and child-only extensions |
| `model`, `fallbackModels`, `thinking` | Inference defaults and retry candidates |
| `systemPromptMode` | Replace or append to Pi's base prompt |
| `inheritProjectContext`, `inheritGlobalContext` | Include repository/user instructions |
| `inheritSkills`, `skills`, `skillPath` | Skill discovery and injection |
| `output`, `defaultReads`, `defaultProgress` | Durable output and task preparation |
| `async`, `timeoutMs`, `toolTimeoutMs` | Execution defaults and limits |
| `acceptance`, `acceptanceRole`, `mutationTools` | Validation contract |
| `completionGuard` | Requirements checked before completion |
| `defaultContext` | Fresh or fork profile default |
| `interactive` | Whether the profile permits interaction |
| `maxSubagentDepth` | Per-agent nesting ceiling |
| `memory` | Per-agent persistent memory behavior |
| `runner` | Native, external CLI, or external-job execution |

Prompt assembly is narrow by default. The role prompt, selected instructions,
declared skills, optional default reads, run task, and runtime bridge guidance
are assembled deliberately instead of copying the parent's entire ambient
prompt.

### Management examples

```js
subagent({ action: "list", capabilities: true })
subagent({ action: "get", agent: "reviewer" })
subagent({
  action: "create",
  agentScope: "project",
  config: {
    name: "api-auditor",
    description: "Read-only API contract auditor",
    tools: "read,grep,find,ls",
    thinking: "high",
    systemPromptMode: "replace",
    systemPrompt: "Audit API compatibility and cite exact source locations."
  }
})
subagent({
  action: "update",
  agent: "api-auditor",
  agentScope: "project",
  config: { thinking: "medium" }
})
subagent({ action: "disable", agent: "researcher" })
subagent({ action: "enable", agent: "researcher" })
subagent({ action: "eject", agent: "reviewer", agentScope: "project" })
subagent({ action: "delete", agent: "api-auditor", agentScope: "project" })
subagent({ action: "reset", agent: "reviewer", agentScope: "project" })
```

`eject` copies a built-in or package profile into an editable scope. Refinement
overlays provide a safer way to tune a profile without changing its base.

---

## Skills, extensions, MCP, and memory

An agent can inherit skills, name specific skills, or disable skill
injection. If a profile explicitly limits tools and receives a skill, the
runtime ensures `read` is available so the child can inspect the skill's
resources. A missing requested skill warns; it does not silently become a
different skill.

The bundled `pi-subagents` skill teaches the parent how to choose roles,
control runs, preserve one-writer ownership, and use workflows. It is
parent-facing rather than a blanket instruction copied into every child.

MCP tools can be named with `mcp:` selectors when the relevant adapter is
loaded. Because ambient extensions are not duplicated in foreground children,
agents depending on MCP or extension-provided models generally need background
execution.

### Per-agent persistent memory

Each native profile may opt into project or user memory. The first 200 lines of
its `MEMORY.md` are injected into the child's prompt. Memory is separate from
Pi's session history. A child can update it only when its effective tool set
permits writing, and the package validates paths to keep writes inside the
memory scope.

### Refinement overlays

Refinement runs a fresh, read-only analysis of evidence from the agent's work
and proposes a bounded overlay under:

```text
.pi/subagents/refinements/<agent>.md
```

The base agent remains unchanged. Revisions are snapshotted and can be shown or
rolled back.

```js
subagent({
  action: "refine",
  agent: "reviewer",
  topic: "Reduce false positives in generated-file reviews"
})
subagent({ action: "refine.show", agent: "reviewer" })
subagent({ action: "refine.rollback", agent: "reviewer" })
```

### Best use scenario

Use memory for stable role-specific knowledge, not live task state. Use
refinement when repeated evidence shows a role needs a narrow behavioral
correction. Use a new agent when the job itself is materially different.

---

## Context control

### Literal context choices

```js
subagent({
  agent: "oracle",
  task: "Check whether this implementation contradicts an earlier architecture decision.",
  context: "fork",
  async: false
})
```

```js
subagent({
  agent: "reviewer",
  task: "Review only the current diff and documented requirements.",
  context: "fresh",
  async: false
})
```

```js
subagent({
  agent: "oracle",
  task: "Perform the role's normal context-sensitive analysis.",
  context: "profile",
  async: false
})
```

`context: "profile"` requires the selected profile to declare
`defaultContext`. It ignores the global default for that launch and fails if
the profile has no default.

### Fork filtering and pruning

Before a child receives a fork, pi-subagents removes parent-only subagent
artifacts while preserving user and assistant prose plus unrelated tool calls.
Signed Anthropic thinking blocks cannot safely be replayed across the fork, so
they are sanitized; resolved Anthropic child thinking is disabled for that
fork. Choose fresh context when Anthropic thinking is more important than
history continuity.

Optional pruned-fork mode enforces a 64 KiB child-session context budget. A
configured model summarizes overflow into stable item references, while raw
bodies and metadata go into a private sidecar. Missing credentials, invalid
summary output, remaining overflow, or recovery-validation failure aborts the
launch. It does not fall back to a full fork.

---

# Part III — Orchestration

## WorkflowScript is the current API

Version 0.65.1 uses `workflowScript`: JavaScript statements executed
inside a filesystem-free orchestration sandbox.

The old top-level `chain`, `tasks`, `parallel`, and `chainDir` request
shapes, plus the old `/chain`, `/parallel`, and `/run-chain` execution
commands, are removed. A saved `.chain.md` file is not a current executable
workflow. Use `workflowScript`, `workflowScriptPath`, or an extension-owned
named `workflow` resource.

### Sandbox surface

| Global | Purpose |
| --- | --- |
| `runs.run(key, spec)` | Start one stable-key child |
| `runs.all(specs)` | Start children concurrently and return ordered results |
| `runs.lanes(lanes)` | Run sequential stages inside parallel lanes |
| `runs.steer(key, message, options)` | Guide a named live child |
| `runs.status(key)` | Read named-child state |
| `runs.ref(key)`, `runs.refs()` | Obtain durable child references |
| `runs.host(resource, args)` | Invoke an authorized named host resource |
| `emit(value)` | Emit structured workflow progress |
| `console` | Bounded workflow logging |
| `state.get()`, `state.set(value)` | Durable mission state when enabled |

The sandbox has no filesystem, shell, Pi tools, or general host globals.
`workflowScriptPath` is read before the sandbox starts.

Scripts must explicitly `return`. Top-level `await`, plain helper functions,
and explicit promise chains are supported. Nested async functions, async arrow
helpers, and async methods are rejected because their child promises cannot be
tracked reliably across runtimes.

### Sequential workflow

```js
subagent({
  workflowScript: `
    const context = await runs.run("scout", {
      agent: "scout",
      task: "Map the settings persistence path and return exact files and symbols."
    });

    const implementation = await runs.run("worker", {
      agent: "worker",
      task: "Using this scout report, implement the smallest correct fix:\n" + context.output
    });

    const review = await runs.run("review", {
      agent: "reviewer",
      task: "Review the worker result and the current diff:\n" + implementation.output,
      context: "fresh"
    });

    return { context, implementation, review };
  `,
  async: true,
  isolation: "none"
})
```

### Parallel review

```js
subagent({
  workflowScript: `
    const reviews = await runs.all([
      {
        key: "correctness",
        agent: "reviewer",
        task: "Review the diff for correctness and regressions."
      },
      {
        key: "security",
        agent: "reviewer",
        task: "Review the diff for trust-boundary and data-exposure flaws."
      },
      {
        key: "tests",
        agent: "reviewer",
        task: "Review whether the tests prove the stated behavior."
      }
    ]);
    return reviews;
  `,
  async: true
})
```

`runs.all()` returns results in request order, not completion order.

### Parallel sequential lanes

```js
subagent({
  workflowScript: `
    const lanes = await runs.lanes([
      {
        key: "api",
        stages: [
          { key: "scout", agent: "scout", task: "Map the API change surface." },
          { key: "writer", agent: "worker", task: "Implement the approved API change and validate the lane." }
        ]
      },
      {
        key: "docs",
        stages: [
          { key: "scout", agent: "scout", task: "Find every user-facing document affected." },
          { key: "writer", agent: "worker", task: "Update every affected document and validate its examples." }
        ]
      }
    ]);
    return lanes;
  `,
  async: true,
  worktree: true
})
```

Lanes run in parallel with sequential stages within each lane. Limits are 32
lanes, 16 stages per lane, 64 stages total, and 64 KiB of lane JSON. A failed
stage blocks its lane without erasing successful work in other lanes. A stage
can use `resume: "previous"` to continue the retained child from the prior
stage.

### Dynamic fan-out

```js
subagent({
  workflowScript: `
    const inventory = await runs.run("inventory", {
      agent: "scout",
      task: "Return JSON with a modules array. Each item must have name and path.",
      outputSchema: {
        type: "object",
        required: ["modules"],
        properties: {
          modules: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              required: ["name", "path"],
              properties: {
                name: { type: "string" },
                path: { type: "string" }
              }
            }
          }
        }
      }
    });

    const reviews = await runs.all(
      inventory.structuredOutput.modules.map((module) => ({
        key: "review-" + module.name,
        agent: "reviewer",
        task: "Review module " + module.path + " for contract violations."
      }))
    );

    return { inventory, reviews };
  `,
  async: true,
  maxSubagentSpawnsPerRun: 13,
  globalConcurrencyLimit: 4
})
```

### Rolling concurrency

A workflow can launch `runs.run()` promises, keep a bounded set in flight,
and use `Promise.race()` to refill capacity. Every launched promise must be
observed before the script returns. Use rolling concurrency when the input set
is known dynamically and launching all children at once would exceed a provider
or cost boundary.

### Validation before launch

```js
subagent({
  action: "validate",
  workflowScript: `
    const result = await runs.run("review", {
      agent: "reviewer",
      task: "Review the current diff."
    });
    return result;
  `
})
```

Validation is offline. It checks syntax, unsupported constructs, boundedness,
agent references, and declared policy without starting children.

---

## Named workflow resources and host gates

Extensions can register named workflow resources. A named resource owns its
script, argument validation, provenance, and authority. It is safer than
accepting arbitrary model-authored shell or filesystem access.

```js
subagent({
  workflow: "review",
  args: {
    focus: "session persistence",
    severity: "blockers"
  },
  async: true
})
```

Only named, authorized resources can call `runs.host()`. The packaged host
resources include bounded review and CI behavior; `run-ci` permits the
approved npm test/typecheck family rather than arbitrary shell, does not accept
stdin, and does not offer per-step working directories.

For a simple one-command acceptance gate:

```js
subagent({
  agent: "worker",
  task: "Fix the parser regression.",
  gate: "pnpm -F @acme/parser test",
  async: true
})
```

Gate results are memoized against relevant workspace and environment state.
When worktree isolation is active, the gate runs in the child worktree.

### Prompt shortcuts

The package includes prompt templates:

- `/parallel-review`
- `/review-loop`
- `/parallel-research`
- `/gather-context-and-clarify`
- `/parallel-cleanup`
- `/council`

`/prompt-workflow` helps author a WorkflowScript. Review and cleanup
templates can opt into autofix where their template contract allows it.

The council mode runs deliberate passes with explicit contracts so multiple
perspectives converge into one decision rather than producing an unranked pile
of opinions.

### Best use scenario

- Use a prompt shortcut for a common interactive pattern.
- Use inline WorkflowScript for a one-off bounded orchestration.
- Use a script file for a reviewed repeatable workflow.
- Use a named workflow resource when an extension must grant narrow host
  authority.

---

## Worktree isolation and lane evidence

Parallel writers in one checkout are unsafe. `worktree: true`
gives managed native children separate Git worktrees. A run can set a base
reference, use the native Git allocator or Worktrunk, and run a setup hook.

When a lane finishes, pi-subagents captures:

- the branch and worktree identity;
- changed files and diff/patch information;
- output and handoff paths;
- validation and acceptance evidence;
- cleanup authority in a handoff manifest.

Lane metadata such as `key`, `mode`, `sourceRef`, `claims`, and
`outputPaths` is display and triage data. It does not grant merge authority.

```js
subagent({
  workflowScript: `
    const results = await runs.all([
      {
        key: "host",
        agent: "worker",
        task: "Implement the host-side change.",
        lane: {
          version: 1,
          key: "host",
          mode: "mutation",
          claims: ["packages/host"],
          outputPaths: ["packages/host"]
        }
      },
      {
        key: "ui",
        agent: "worker",
        task: "Implement the UI-side change.",
        lane: {
          version: 1,
          key: "ui",
          mode: "mutation",
          claims: ["packages/ui"],
          outputPaths: ["packages/ui"]
        }
      }
    ]);
    return results;
  `,
  async: true,
  worktree: true,
  baseRef: "main"
})
```

### Lane lifecycle actions

```js
subagent({ action: "lane.status", handoffPath: "/tmp/handoff.json", laneId: "host" })
subagent({
  action: "lane.recordMerge",
  handoffPath: "/tmp/handoff.json",
  laneId: "host",
  merge: {
    prNumber: 42,
    reviewedHead: "abc123",
    mergeCommit: "def456",
    treeEquivalent: true,
    postMergeChecks: ["pnpm test"],
    attestedBy: "release-operator",
    attestedAt: "2026-09-07T10:00:00Z"
  }
})
subagent({
  action: "lane.recordSupersession",
  handoffPath: "/tmp/handoff.json",
  laneId: "host",
  supersession: {
    supersededBy: "host-v2",
    attestedBy: "release-operator",
    attestedAt: "2026-09-07T10:05:00Z"
  }
})
```

`worktree.cleanup` is currently plan-only. It reports what is eligible and
why; apply/removal is reserved for a later implementation. Cleanup fails closed
when the manifest is missing, invalid, unmerged, or lacks explicit disposal
authority. `worktree.discard` is the explicit destructive route and is
subject to authority policy.

---

# Part IV — Control, reliability, and evidence

## Status, waiting, steering, pausing, stopping, and reviving

### Observe

```js
subagent({ action: "status" })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "run-prefix" })
subagent({
  action: "status",
  id: "run-prefix",
  index: 0,
  view: "transcript",
  lines: 120
})
```

Transcript tails are capped at 500 lines. Status can resolve a unique ID prefix,
show one child by zero-based index, or display the active fleet.

### Wait

```js
bg_wait({ id: "run-prefix", timeoutMs: 120000 })
bg_wait({ all: true, timeoutMs: 300000 })
bg_wait({ id: "run-prefix", stopOnAttention: false, timeoutMs: 300000 })
bg_wait({ id: "run-prefix", nonBlocking: true, timeoutMs: 1800000 })
```

Ordinary async native subagents already notify their parent; they usually do not
need `bg_wait`. Use it when the same turn truly needs the result, or for
provider, detached foreground, or other registered background work without a
native completion wake.

A wait timeout returns a non-error `window_elapsed` result. The work keeps
running. `nonBlocking: true` stores an exact-run wake subscription and returns
immediately. By default a blocking wait stops when work needs attention;
`stopOnAttention: false` waits through idle or long-thinking attention, but a
supervisor contact still wakes it.

### Steer

```js
subagent({
  action: "steer",
  id: "run-prefix",
  message: "Do not change the public schema. Fix the adapter instead.",
  mode: "steer"
})
```

Modes:

- `steer` interrupts at a safe boundary and injects guidance;
- `follow_up` queues guidance after the current turn;
- `auto` chooses live steering while active and follow-up between turns.

Queues are FIFO and capped at 20 messages. An acknowledgment proves delivery,
not compliance. Direct tool steering may pause and revive a child after a
missed acknowledgment. Versioned extension RPC steering disables that recovery
so the caller retains exact-child ownership.

### Interrupt, resume, stop, dismiss

```js
subagent({ action: "interrupt", id: "run-prefix" })
subagent({
  action: "resume",
  id: "run-prefix",
  message: "Continue from the persisted session and finish the focused validation."
})
subagent({
  action: "resume",
  id: "workflow-prefix",
  index: 1,
  message: "Address the review finding and return updated evidence."
})
subagent({ action: "stop", id: "run-prefix" })
subagent({ action: "dismiss", id: "run-prefix" })
```

- **Interrupt** pauses and preserves resumability.
- **Resume** loads a persisted child JSONL into a new live child session. It is
  continuity of history, not the original in-memory instance.
- **Stop** is terminal and non-resumable. It is stronger than interrupt.
- **Dismiss** hides a recovered workflow that still looks running but no longer
  has a live controller. It marks the display record dismissed; it does not
  terminate work. Ordinary terminal runs are not the target of this action.

Resume uses an exclusive cross-process lease to prevent two writers from
reviving the same session. The last ten retained workflow children are exposed
for continuation. A stopped child cannot be resumed. External jobs can accept a
follow-up only if their provider implements it.

A foreground single child can be detached through an optional shortcut. It
continues in the parent process, so detach does not make it survive process
reload.

### Supervisor coordination

An eligible child receives `contact_supervisor`:

```js
contact_supervisor({
  reason: "need_decision",
  message: "The public schema and stored data disagree. Which one is authoritative?"
})
```

Reasons are `need_decision`, `interview_request`, and `progress_update`.
The parent receives `subagent_supervisor` operations to inspect and reply.
Routing is tied to the exact parent session. A detached workflow pauses for
reconciliation instead of guessing past a required decision.

---

## Time, tool, usage, spawn, and concurrency budgets

| Budget | Behavior |
| --- | --- |
| Run timeout | Foreground and plain async single runs default to 30 minutes |
| Composite async timeout | No top-level default; child limits still apply |
| Tool timeout | Configurable; known-fast built-ins default to 5 minutes |
| Tool-call budget | Soft nudge, then hard blocking for named tools or all tools |
| Usage budget | Soft/hard token or cost thresholds based on reported usage |
| Session spawn budget | Optional cap, extendable only with explicit user grant |
| Per-run spawn budget | Cumulative nested cap; default 64, no refunds |
| Active async budget | Optional per-session live-run cap |
| Global concurrency | Shared launch limit; configurable |
| Recursion depth | Global and per-agent nesting ceiling |

A hard usage limit prevents future launches after reconciled usage crosses the
boundary. It does not reserve usage in advance and does not kill already
running children. A run timeout is terminal and does not trigger model fallback.

```js
subagent({
  agent: "scout",
  task: "Inventory the request-routing layer.",
  toolBudget: {
    soft: 20,
    hard: 30,
    block: ["read", "grep", "find", "ls"]
  },
  usageBudget: {
    tokens: { soft: 30000, hard: 50000 },
    costUsd: { soft: 1.5, hard: 2.5 }
  },
  timeoutMs: 900000,
  toolTimeoutMs: 300000,
  async: true
})
```

For writers, avoid a hard tool budget that blocks mutation tools before the
child can finish or repair its work.

When a configured session spawn cap is exhausted, an interactive root parent
can request an explicit user-confirmed grant:

```js
subagent({ action: "grant-spawn-budget", additional: 4 })
```

The grant cannot exceed the original configured ceiling and is not reset by
context compaction.

---

## Models, fallback, thinking, and policy

Model selection precedence is:

1. per-run override;
2. provider-scoped role override;
3. agent override;
4. agent frontmatter;
5. configured default model;
6. parent model.

Use provider-qualified IDs where ambiguity matters:

```js
subagent({
  agent: "reviewer",
  task: "Review the concurrency fix.",
  model: "openai-codex/gpt-5.6-sol:high",
  async: true
})
```

The suffix selects child thinking: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`, subject to provider support and configured
ceilings. A global switch can disable thinking; `maxThinking` can cap it.

Fallback models apply to retryable provider, authentication, quota,
unavailability, and eligible model-call failures. They do not turn an ordinary
task failure or expired outer timeout into a retry on another model.

Fast mode is an explicit priority-service opt-in for supported native
OpenAI-Codex child models on the package's allowlist:

```js
subagent({
  agent: "scout",
  task: "Locate the regression and return a compact handoff.",
  model: "openai-codex/gpt-5.6-luna:low",
  fast: true,
  async: true
})
```

Model scope rules can allow or deny provider/model globs globally and per agent.
The effective scope is the intersection; children cannot widen it. A special
`inherit` allowance permits the current parent route.

`modelResponseAliases` can attest exact response IDs for a requested
provider/model route. Matching is exact and case-sensitive; it does not rewrite
the requested route or authorize a fallback. Temporary model exclusions cache
known failures with a TTL, and authentication-related exclusions are invalidated
when the auth file changes.

Profile commands can refresh provider catalogs with live probes, generate
quota/quality profiles, load them, and verify the live mapping.

---

## Acceptance is a contract, not a confident paragraph

### Policy levels

| Requested level | Meaning |
| --- | --- |
| `auto` | Infer policy from risk and mutation behavior |
| `false` or `{ level: "none", reason }` | No acceptance gate, with explicit rationale |
| `attested` | Child reports required evidence |
| `checked` | Runtime checks declared evidence/gates |
| `verified` | Stronger verification path when configured |

`reviewed` is an achieved evidence status, not a valid requested policy.

Auto policy generally makes read-only work ungated, ordinary writers checked,
and riskier async or dynamic writers checked with required review.

### Evidence kinds

- `changed-files`
- `tests-added`
- `commands-run`
- `validation-output`
- `residual-risks`
- `no-staged-files`
- `diff-summary`
- `review-findings`
- `manual-notes`

### Literal checked run

```js
subagent({
  agent: "worker",
  task: "Fix duplicate request delivery without changing the protocol.",
  acceptance: {
    level: "checked",
    evidence: [
      "changed-files",
      "commands-run",
      "validation-output",
      "diff-summary",
      "residual-risks"
    ],
    review: {
      required: true,
      agent: "reviewer"
    }
  },
  async: true
})
```

The child can return a standardized fenced acceptance report or strict
structured output. The parser canonicalizes only safe known synonyms. Gate
results are stored separately from prose.

Evidence status moves through:

`claimed → attested → checked → verified`

Review-required work can then become `reviewed` or `rejected`.

### Best use scenario

Use checked acceptance for code mutation, verified acceptance for
release-sensitive work, and explicit none only for genuinely read-only or
advisory tasks.

---

## Watchdog and native child permissions

The watchdog is an optional second-model guard. It is not the same as
the reviewer role.

It can run:

- at `agent_end` when the repository changed;
- every configured number of tools, with a minimum cadence of five;
- after a JavaScript/TypeScript language-service prepass.

The watchdog sees the turn delta, current scope, watchdog diff, optional
`WATCHDOG.md`, and language-service findings. If nothing changed, it stays
quiet. A warning is steered back into the active child for another pass. A
default stalemate limit of three repeated endings prevents endless loops.

```js
subagent({ action: "watchdog.status", target: "main" })
subagent({
  action: "watchdog.configure",
  scope: "session",
  target: "children",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "high"
})
subagent({ action: "watchdog.check", target: "main" })
subagent({ action: "watchdog.recommend-model", target: "children" })
```

Launch rules can warn or block selected models before spawn. Native child tool
permissions support `allow`, `ask`, and `deny` for non-bash tools. An
`ask` decision uses the watchdog arbiter and fails closed if it cannot decide.
Bash policy is deliberately rejected here; use a dedicated shell guard such as
`pi-guard`. External CLI profiles do not use native child permission
arbitration.

### Best use scenario

Use a reviewer for an independent verdict. Use the watchdog when a writer
should be automatically challenged at controlled boundaries before it is
allowed to settle.

---

# Part V — Durable work

## Missions

A mission is the durable container around an objective. It can link:

- title, summary, objective, and labels;
- run IDs and their modes/statuses;
- decisions and decision resolutions;
- artifacts;
- delivery receipts;
- optional goal state and token budget;
- bounded durable workflow state.

Workflow launches create a mission by default unless `mission: false` is
explicit. Persistence warnings are normally nonfatal; strict mission policy can
make them launch-blocking.

```js
subagent({
  action: "mission.create",
  mission: {
    title: "Harden session recovery",
    objective: "Make reconnect and resume lossless across process replacement.",
    labels: ["reliability", "sessions"]
  }
})
subagent({ action: "mission.list", missionScope: "project" })
subagent({ action: "mission.list", missionScope: "global" })
subagent({ action: "mission.show", missionId: "mission-id" })
subagent({
  action: "mission.update",
  missionId: "mission-id",
  missionUpdate: {
    decisions: [{
      id: "storage-authority",
      question: "Which store is authoritative after reconnect?",
      status: "open"
    }]
  }
})
subagent({
  action: "mission.resolve-decision",
  missionId: "mission-id",
  id: "storage-authority",
  message: "The host store is authoritative; browser storage is only a boot cache."
})
subagent({
  action: "mission.attach-run",
  missionId: "mission-id",
  runId: "run-id",
  runMode: "workflow",
  runStatus: "running"
})
subagent({
  action: "mission.close",
  missionId: "mission-id",
  missionStatus: "completed",
  summary: "Recovery is implemented and verified."
})
```

Mission-scoped WorkflowScript receives bounded JSON state:

```js
subagent({
  mission: {
    title: "Audit packages",
    objective: "Review every package exactly once."
  },
  workflowScript: `
    const current = state.get() || { reviewed: [] };
    const result = await runs.run("review-protocol", {
      agent: "reviewer",
      task: "Review packages/protocol."
    });
    state.set({ reviewed: current.reviewed.concat(["packages/protocol"]) });
    return result;
  `,
  async: true
})
```

Mission state is capped at 256 KiB.

### Goal missions

A goal mission adds `goal: true` and a required token budget. After turns, it
can notify the parent that the goal still needs attention. It does not silently
launch more children or replan. Goal state can be paused, resumed, disabled, or
marked budget-exhausted.

```js
subagent({
  mission: {
    title: "Eliminate flaky transport tests",
    objective: "Find, fix, and verify every deterministic source of flakiness.",
    goal: true,
    budget: { tokens: 180000 }
  },
  workflowScript: `
    const scout = await runs.run("scout", {
      agent: "scout",
      task: "Inventory transport test flakes and rank by evidence."
    });
    return scout;
  `,
  async: true
})
```

---

## Schedules

Schedules persist a WorkflowScript target for:

- one execution at an ISO timestamp;
- one execution after a relative delay such as `+10m`;
- a fixed interval in minutes, hours, days, or weeks.

Scheduled executions are always async, fresh-context, and do not automatically
create a mission. Overlap policy is currently `skip`. Catch-up is `latest`
or `none`.

```js
subagent({
  action: "schedule.create",
  name: "nightly-review",
  every: "1d",
  catchUp: "latest",
  overlap: "skip",
  workflowScript: `
    return runs.run("nightly-review", {
      agent: "reviewer",
      task: "Review changes since the current base and report release blockers."
    });
  `
})
subagent({
  action: "schedule.create",
  name: "ten-minute-check",
  at: "+10m",
  workflowScript: `
    return runs.run("check", {
      agent: "scout",
      task: "Check whether the migration process is still active and summarize evidence."
    });
  `
})
subagent({ action: "schedule.list" })
subagent({ action: "schedule.show", id: "schedule-id" })
subagent({ action: "schedule.history", id: "schedule-id" })
subagent({ action: "schedule.pause", id: "schedule-id" })
subagent({ action: "schedule.resume", id: "schedule-id" })
subagent({ action: "schedule.run", id: "schedule-id" })
subagent({ action: "schedule.run-due" })
subagent({ action: "schedule.delete", id: "schedule-id" })
```

There is no resident scheduler daemon in the extension. An external runner
invokes `schedule.run-due`. Schedule stores, history, events, and receipts use
private file modes. Calendar expressions, cron syntax, replacement queues, and
interactive schedule UI are not implemented in this version.

---

# Part VI — Observability and integrations

## Seeing the fleet

Foreground calls render a rich live child card in Pi's terminal UI. Background
work appears through:

- completion notifications;
- an optional under-editor async widget;
- persistent FleetView;
- the full fleet inspector;
- status and transcript tool views;
- lifecycle events and artifacts.

FleetView shows top-level and nested work, state, current activity, tokens, cost,
context-window use, and control affordances. The inspector supports navigation,
tool expansion, refresh, steer, stop, and child inspection. The default shortcut
is `Ctrl+Alt+F`; keybindings are configurable.

An optional Herdr integration can host inspector and project panes. The optional
Orca observer creates terminal tabs and mirrors progress on macOS or Linux.
Orca is best-effort and never becomes the execution authority. Its mirror is
capped, strips terminal controls, and is removed after the run; the Orca tab
and scrollback remain until the user closes them.

### Async artifact layout

```text
<temp-root>/pi-subagents-<scope>/async-subagent-runs/<run-id>/
  status.json
  events.jsonl
  output-0.log
  subagent-log-0.md
  control/
```

- `status.json` is the authoritative compact snapshot.
- `events.jsonl` wraps lifecycle records and child Pi events.
- `output-N.log` is a human-readable tail.
- `subagent-log-N.md` and session references preserve detailed handoff.
- debug runs and workflows have their own bounded artifact records.

Process death is not inferred merely from an old file, missing PID, or failed
PID probe. Terminal proof requires observing the exact runner close and the
session lease becoming free.

Completion delivery batches ordinary successes when configured, while failures,
pauses, and attention requests surface promptly. Result-index scans can log all
slow scans, only scans with activity, or none.

### Sharing

```js
subagent({
  agent: "reviewer",
  task: "Produce a review that can be shared with the team.",
  share: true,
  sessionDir: "/tmp/review-sessions",
  async: true
})
```

Sharing exports the child session and can create a private GitHub Gist URL.
Treat it as disclosure: transcripts can contain source, paths, prompts, tool
output, or secrets.

---

## Public integration surfaces

pi-subagents exposes reusable interfaces for other Pi extensions.

### In-process RPC

The versioned `subagents:rpc:v1` bus supports:

- `ping` capability discovery;
- status and fleet snapshots;
- a restricted management allowlist, including schedules;
- async spawn;
- exact-child steer without recovery;
- interrupt;
- stop;
- resume.

Calls are scoped to the live Pi session. Consumers should probe capabilities
with a timeout instead of inferring support from a package version.

### Runtime agent registration

Independent extensions can register agent profiles at runtime through a shared
event contract. Registration is reload-safe and does not require writing an
agent file.

### External runs

Extensions can publish display-only external work into FleetView. These records
carry identity, source, label, lifecycle, activity, preview, and optional
transcript/report paths. Display registration grants no control authority.

### Launch preflight

A side-effect-free preflight resolves an intended launch before work starts:
agent identity, tools, model, context, extensions, limits, policy, and validation
errors. Integrators can show truthful capabilities without launching a child.

### Structured delegation API

Extensions can request a foreground leaf delegation through a typed contract
with identity, structured schema, progress, usage, and bounds. This is the
programmatic alternative to having a model emit a `subagent` tool call.

### Capability ceilings

A parent can impose an allowlist of agents and tools and a deny-extension flag.
Children inherit a monotonic intersection: they may narrow authority but never
widen it. This is orchestration policy, not an operating-system sandbox.

### Background-work provider API

Other extensions can register active background work so `bg_wait` and fleet
snapshots can observe it. Snapshots are validated and filtered to the exact
session. Wake signals shorten polling; validated snapshots remain authoritative.

### External-job provider bridge

A provider can back `runner.type: external-job` profiles with durable
`start`, `followup`, `status`, `result`, and `reattach` operations.
The operation identity prevents a provider job from being started twice during
recovery.

### Child tool plans and extension bindings

Integrators can calculate a child-safe tool plan before launch. Bounded,
plain-JSON `extensionBindings` can pass namespaced metadata such as
`vendor.feature/1` only to the child runtime that needs it.

---

## Complete command and action inventory

### Model-callable tools

| Tool | Purpose |
| --- | --- |
| `subagent` | Execute, orchestrate, inspect, control, and manage |
| `bg_wait` | Blocking or subscribed waiting for registered background work |
| `subagent_supervisor` | Parent-side inspection and reply for child contacts |
| `contact_supervisor` | Child-side decision, interview, or progress contact |

The nested child-safe `subagent` tool is exposed only when nesting is
authorized.

### Slash commands

- `/prompt-workflow`
- `/run`
- `/subagent-cost`
- `/subagents`
- `/subagents-check-profile`
- `/subagents-detach`
- `/subagents-doctor`
- `/subagents-fleet`
- `/subagents-generate-profiles`
- `/subagents-guide`
- `/subagents-inspect-rpc`
- `/subagents-load-profile`
- `/subagents-models`
- `/subagents-profiles`
- `/subagents-refine`
- `/subagents-refresh-provider-models`
- `/subagents-steer`
- `/subagents-stop`
- `/subagents-watchdog`

### Every `subagent({ action })` value in 0.65.1

| Family | Actions |
| --- | --- |
| Discovery | `list`, `get`, `models`, `children.list`, `guide`, `validate` |
| Agent authoring | `create`, `update`, `delete`, `eject`, `disable`, `enable`, `reset` |
| Missions | `mission.create`, `mission.list`, `mission.show`, `mission.update`, `mission.resolve-decision`, `mission.attach-run`, `mission.close` |
| Worktrees/lanes | `worktree.discard`, `worktree.cleanup`, `lane.status`, `lane.recordMerge`, `lane.recordSupersession` |
| Refinement | `refine`, `refine.show`, `refine.rollback` |
| Herdr panes | `inspector.open`, `inspector.status`, `inspector.close`, `project.open`, `project.status`, `project.close` |
| Run control | `status`, `debug.run`, `grant-spawn-budget`, `interrupt`, `resume`, `steer`, `stop`, `dismiss` |
| Diagnostics | `doctor` |
| Watchdog | `watchdog.status`, `watchdog.check`, `watchdog.configure`, `watchdog.recommend-model` |
| Scheduling | `schedule.create`, `schedule.list`, `schedule.show`, `schedule.history`, `schedule.pause`, `schedule.resume`, `schedule.run`, `schedule.run-due`, `schedule.delete` |

---

## Complete top-level parameter map

The execution schema deliberately shares one object across launch, workflow,
management, and control modes. A field is valid only when its mode accepts it;
preflight rejects contradictory combinations.

| Parameters | Purpose |
| --- | --- |
| `agent`, `task` | Direct single-child execution |
| `workflow`, `args` | Extension-owned named workflow resource |
| `workflowScript`, `workflowScriptPath` | Inline or file-backed current workflow API |
| `action`, `capabilities`, `topic` | Management mode and guide/list options |
| `id`, `runId`, `dir`, `index`, `childId` | Resolve a run, workflow child, transcript, or control target |
| `view`, `lines` | Fleet or bounded transcript status view |
| `message`, `mode`, `steeringRecovery` | Resume/steer text, delivery mode, and direct-call recovery |
| `context` | `fresh`, `fork`, or strict `profile` selection |
| `async`, `timeoutMs`, `maxRuntimeMs`, `toolTimeoutMs` | Foreground/background and deadlines |
| `model`, `thinking`, `fast` | Model route, watchdog configuration thinking, and priority tier |
| `skill`, `output`, `outputMode`, `outputSchema` | Child skills and result contract |
| `artifacts`, `includeProgress`, `share`, `sessionDir` | Debug files, returned progress, sharing, and session storage |
| `cwd` | Execution or project-pane working directory |
| `extensionBindings` | Bounded namespaced JSON passed to child extensions |
| `globalConcurrencyLimit`, `maxSubagentSpawnsPerRun` | Workflow launch bounds |
| `toolBudget`, `usageBudget` | Child tool and reported-usage bounds |
| `acceptance`, `agentContract`, `gate` | Compatibility and evidence contract |
| `preflight`, `chatProgress` | Display-only lane preview and live chat projection |
| `isolation`, `worktree`, `baseRef`, `lane` | Child isolation and lane metadata |
| `control` | Attention thresholds and notification channels |
| `mission`, `missionId`, `missionUpdate`, `missionStatus`, `missionScope`, `runMode`, `runStatus`, `summary` | Mission launch and management |
| `name`, `at`, `every`, `sessionOnly`, `on`, `timezone`, `overlap`, `catchUp` | Schedule identity and trigger policy; `on`/calendar selection is reserved |
| `config`, `agentScope` | Agent create/update and user/project scope |
| `additional` | Explicit spawn-budget grant |
| `scope`, `target`, `focus` | Watchdog persistence/target or Herdr pane focus |
| `handoffPath`, `repo`, `planId`, `laneId`, `merge`, `supersession` | Worktree cleanup planning and lane evidence |

The one-child and workflow-child specs can override relevant execution
defaults such as agent, task, context, model/thinking suffix, fast mode, skill,
output, output mode/schema, reads, progress, tool budget, acceptance, gate,
worktree, lane metadata, and extension bindings. The outer workflow can set
defaults that each child narrows.

`bg_wait` has its own small schema: `id`, `nonBlocking`, `all`, `timeoutMs`, and
`stopOnAttention`.

---

## Configuration inventory

Upstream pi-subagents reads extension config from:

```text
~/.pi/agent/extensions/subagent/config.json
```

Pi settings hold model-, agent-, project-root-, extension-, and watchdog-level
keys. Environment variables can override selected process behavior.

### Config keys and feature groups

| Key | Controls |
| --- | --- |
| `toolDescriptionMode` | Full, compact, or custom parent tool guidance |
| `inlineToolDisplay` | Rich live result or one-line summary |
| `mainWindowRenderer` | Main-chat spacing and collapsed-line cap |
| `foregroundDetachShortcut` | Key to detach an active foreground single run |
| `orcaProgressTabs` | Experimental passive Orca progress observer |
| `asyncByDefault` | Default background behavior |
| `forceTopLevelAsync` | Force depth-zero launches into background mode |
| `defaultSubagentContext` | Global fresh/fork preference |
| `forkContext` | Full or pruned fork preparation |
| `fleetView`, `fleetViewPlacement`, `fleetKeybindings` | Persistent fleet presentation |
| `asyncWidget` | Under-editor background-work widget |
| `waitTool` | Enablement and default `bg_wait` window |
| `resultScanLogging` | Slow result-index scan logging |
| `timeoutMs`, `toolTimeoutMs` | Runtime and tool deadlines |
| `globalConcurrencyLimit` | Shared live child limit |
| `maxSubagentSpawnsPerSession` | Session launch allowance |
| `maxSubagentSpawnsPerRun` | Cumulative root-run child allowance |
| `maxActiveAsyncRunsPerSession` | Concurrent detached-run allowance |
| `scheduledRuns` | Scheduler store and runner behavior |
| `parallel` | Parallel defaults and boundedness |
| `defaultSessionDir` | Child session storage |
| `singleRunOutputBaseDir` | Managed output base for single runs |
| `maxSubagentDepth` | Recursion ceiling |
| `PI_SUBAGENT_PI_BINARY` | Compatible Pi binary override where used |
| `intercomBridge` | Optional external coordination bridge |
| `worktreeBaseDir`, `worktreeProvider`, `worktreeSetupHook` | Isolation allocation and setup |
| `missions` | Mission persistence/default policy |
| `authorityPolicy` | Destructive and privileged operation decisions |
| `artifactDir` | Debug/workflow artifact location |
| `completionBatch` | Completion grouping and delivery |
| `permissions` | Native child tool permission rules |
| `modelResponseAliases` | Exact accepted response-model identities |
| `modelExclusions` | Cached failure TTL |
| `PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS` | Filesystem retry ceiling |

### Pi settings used by pi-subagents

- `subagents.defaultModel`
- `subagents.defaultProvider`
- `subagents.defaultThinking`
- `subagents.defaultExtensions`
- `subagents.agentOverrides`
- `subagents.agentScanDirs`
- `subagents.modelScope`
- `subagents.disableThinking`
- `subagents.disableBuiltins`
- `subagents.projectRootResolution`
- watchdog settings

Project-root resolution can use the nearest configured project or a Git-root
policy. Additional scan directories support one wildcard path segment.

### Diagnostic examples

```js
subagent({ action: "doctor" })
subagent({ action: "models" })
subagent({ action: "models", agent: "reviewer" })
subagent({ action: "children.list" })
subagent({ action: "guide" })
subagent({ action: "debug.run", id: "run-prefix" })
```

---

# Part VII — How Laser is built on Pi and pi-subagents

## The product boundary

Laser does not reimplement Pi. It embeds the exact Pi SDK in a worker
and speaks an engine-neutral protocol above that worker.

```text
Laser UI (Electron, browser, or phone)
        │
        │ @lasercode/protocol over WebSocket
        ▼
Laser host
        │
        │ one worker process per project directory
        ▼
Laser worker
        │
        ├── StableSdkDriver
        ├── pinned Pi 0.85.0 AgentSessionRuntime
        ├── pinned pi-subagents 0.65.1
        └── Laser companion Pi extension
```

The architectural rules are deliberate:

- only `packages/worker` and `packages/pi-extension` import Pi or
  Pi-community runtime semantics;
- UI, host, and protocol do not import Pi;
- one worker process owns one project directory;
- every Pi session file has only one writer;
- the relay forwards encrypted bytes and does not interpret agent content;
- the UI renders untrusted agent output safely.

### The driver seam

`SessionDriver` converts protocol intents into engine operations. The real
`StableSdkDriver` uses Pi; `ChordDriver` is a compiling stub that proves the
upper layers are not coupled to Pi types.

The stable driver maps:

| Laser intent | Pi operation |
| --- | --- |
| Open/create/load | `createAgentSessionRuntime`, `switchSession`, `newSession` |
| Send | `session.prompt()` |
| Steer/follow-up | `session.steer()`, `session.followUp()` |
| Cancel | `session.abort()` |
| Model/thinking | `session.setModel()`, `session.setThinkingLevel()` |
| Compact | `session.compact()` |
| Navigate/fork | runtime tree/session operations |
| Live transcript | `session.subscribe()` event mapping |

On every session replacement, Laser unsubscribes from the old session, clears
pending tool state, binds the companion extension in RPC UI mode, and
subscribes to the new session.

---

## How Laser loads pi-subagents

When a project's Laser-owned Subagents feature is enabled, the worker:

1. resolves the exact installed `pi-subagents` entrypoint;
2. loads it as an additional Pi extension;
3. adds its bundled skills;
4. adds its prompt templates;
5. sets `PI_SUBAGENTS_TEMP_ROOT` to a host-selected location;
6. loads Laser's companion extension inline beside it.

Laser disables automatic project `.pi` discovery:

- Pi's project is marked untrusted for resource discovery;
- package, extension, skill, prompt, and theme settings are cleared;
- reviewed feature entrypoints are added explicitly;
- Laser-owned and Agent Skills roots are added explicitly;
- agent files whose paths include `.pi` are filtered;
- validated project settings come from `<project>/.laser`.

That is the practical meaning of “Laser is the product; Pi is the internal
engine.” Normal Laser users enable a curated **Subagents** feature. They do not
manage Pi packages through Laser's product UI.

---

## Two observation paths, one run

Laser observes subagents in two complementary ways.

### Path A — in-process companion extension

`packages/pi-extension/src/modules/subagents.ts` runs inside the Pi worker.
It can see things that files alone cannot:

- probe `subagents:rpc:v1` with a 750 ms timeout;
- read the actual advertised method and capability map;
- call resume through the owning live session;
- observe external-run registries stored on `globalThis` symbols;
- consume foreground and async completion events immediately;
- receive child-status events;
- translate results into Laser panel events.

The module never imports pi-subagents. Its public event names and DTOs are
treated as an integration contract, keeping Pi-community types out of Laser's
protocol layer.

### Path B — host file layer

`packages/host/src/subagents/` imports neither Pi nor pi-subagents. It parses
the extension's persisted JSON and transcript artifacts.

That lets Laser display runs started:

- inside Laser;
- in another Laser client;
- from a terminal Pi session with no Laser worker attached.

The host polls rather than relying on `fs.watch`. pi-subagents creates
directories during execution, Linux can duplicate or miss watch events, and
the status file is atomically written. A one-second stat-and-compare pass is
bounded, simple, and truthful.

### Deduplication

Both paths derive the same panel IDs from pi-subagents identities. If the bus
and file layer see one child, they upsert the same panel instead of rendering
duplicates. The in-process module emits nothing when it cannot derive the same
stable identity.

---

## How upstream work becomes Laser UI

Laser translates pi-subagents state into its six panel kinds rather than
copying the terminal UI.

| Upstream information | Laser representation |
| --- | --- |
| Background/foreground child | `run` panel |
| Workflow structure and phases | `plan` panel |
| Acceptance/watchdog evidence | `collection` panel |
| Mission list | `collection` panel |
| Mission detail | `document` panel |
| External extension work | Read-only `run` panel |

Those panels can appear as ambient state, inline transcript content, docked
work, or a sheet according to Laser's placement rules. Extensions declare
meaning and intent; Laser owns placement and presentation.

The Subagents UI then provides:

- chronological run trees;
- one-level child tabs with breadcrumbs for deeper nesting;
- active versus terminal fleet separation;
- workflow phases;
- mission documents;
- usage and cost where measured;
- acceptance and watchdog chips;
- artifacts and output links;
- phone and desktop views.

Laser keeps finished runs visible for a bounded recent window and caps the
number shown per session. A malformed status read never becomes “finished”;
Laser preserves the last good state.

### Control truthfulness

Laser exposes an action only when the available control path supports it:

| Run path | Steer | Stop | Resume | Interrupt |
| --- | --- | --- | --- | --- |
| Background, file inbox | Yes | Yes | No | Yes |
| Background, owning bus reachable | Yes | Yes | Yes | Yes |
| Foreground transcript only | No | No | No | No |
| Nested child | No direct steer/stop | No direct stop | Whole run | Whole run |

Steer, stop, and interrupt can be written to the background runner's control
inbox, including for terminal-started work. Resume requires the live owning Pi
session and is offered only after the companion extension advertises that the
bus is reachable.

External runs registered by another extension are read-only unless that source
publishes a real control contract. Unknown cost is displayed as unknown with a
reason, never as zero.

---

## What Laser changes and what it preserves

Laser preserves Pi's strengths:

- the real Pi session and event model;
- branchable transcripts;
- models, thinking, prompts, skills, and extension semantics;
- pi-subagents' native child sessions, workflows, missions, control, and files;
- terminal-started run visibility;
- exact package pins for reproducibility.

Laser changes the experience:

- WebSocket protocol instead of direct TUI ownership;
- desktop and phone surfaces;
- product-curated features instead of package plumbing;
- `.laser` project settings instead of project `.pi` discovery;
- panel placement and responsive rendering;
- shared remote state and encrypted relay access;
- human-readable errors and capability-aware controls.

It also carries a few integration realities. Some desired upstream surfaces are
prepared as patches rather than merged contracts, including richer control
exports and foreground indexing. Laser therefore probes behavior, uses the
documented bus where available, and falls back to file observation without
pretending a missing capability exists.

---

# Part VIII — Compatibility analysis for Laser as a product

## Why this analysis exists

Laser's maintainer is considering subagents as a serious product module, not
as a decorative view over an optional extension. That raises a different
question from “does pi-subagents work?” The relevant question is whether the
package's ownership, persistence, security, scheduling, control, and vocabulary
fit the product Laser is trying to become.

This section is an architectural assessment, not a verdict for or against the
upstream package. It separates three kinds of statement:

| Label | Meaning |
| --- | --- |
| **Verified** | Directly established by the pinned source, package documentation, or current Laser implementation. |
| **Inferred risk** | A credible interaction implied by two verified behaviors, but not yet proven by an end-to-end runtime test. |
| **Product choice** | Neither implementation is intrinsically wrong; Laser must decide what experience and ownership boundary it wants. |

That distinction matters. A naming mismatch can be solved in presentation. A
process-lifecycle mismatch needs an adapter. A trust-boundary violation may
require an upstream hook, a maintained patch, or replacement. They should not
be treated as the same class of problem.

---

## The central overlap: Laser Goals and pi-subagents goal missions

Laser currently ships two independent goal-shaped systems:

1. The **Goals feature** loads `@narumitw/pi-goal@0.54.4` through
   `packages/pi-goal`. Laser reads its canonical `goal-state` session entries
   and exposes start, pause, resume, edit, and clear through an engine-neutral
   protocol.
2. The **Subagents feature** loads `pi-subagents@0.65.1`, whose mission system
   can mark a project mission as `goal: true` when it has a token budget.

They use the same everyday word, but they are not the same abstraction.

| Dimension | Laser Goal / `pi-goal` | pi-subagents goal mission |
| --- | --- | --- |
| Primary scope | One Pi session branch | Durable project mission |
| Quantity | At most one current Goal | Multiple missions can exist, including multiple goal missions owned by one session |
| Objective | One current objective string | Mission title/objective plus runs, decisions, artifacts, state, and receipts |
| Driver | Automatically schedules another parent-model turn after the session settles | Emits a “needs attention” notice after a parent turn when the mission is idle |
| Notice behavior | Active continuation does real model work | Notice uses `triggerTurn: false`; it does not launch or replan work |
| Budget | Optional parent Goal token budget | Mandatory token budget for goal mode; sums linked mission-run tokens |
| Pause | Stops Goal continuation and aborts the owned parent turn | Suppresses goal-mission notices; does not stop linked runs |
| Completion | Model calls `goal_complete` with the current Goal ID and evidence | Caller explicitly closes the mission |
| Persistence | `goal-state` entries on the current session branch | Mission store under the configured agent directory, grouped by project |
| New session | Does not inherit the Goal | Project mission remains available |
| Compatible fork | Goal state can be present in the branched history | Mission remains one project record linked to its owning session/runs |
| Terminal states | Includes completed, blocked, paused, usage-limited, budget-limited | Mission lifecycle plus goal states active, paused, budget-exhausted |

### What does not conflict

**Verified:** There is no command or tool-name collision. `pi-goal` owns
`/goal` and the `goal_complete`, `goal_blocked`, and `goal_wait` tools.
pi-subagents exposes goal missions through `mission.*` actions on the
`subagent` tool. Both packages can load in the same Pi session.

They can also be conceptually complementary:

```text
Session Goal: “Prepare the release safely”
    ↓ parent decides that durable delegated work is needed
Goal mission: “Audit, fix, test, and document the release candidate”
    ├─ scout run
    ├─ implementation run
    └─ independent review run
```

The session Goal can express why the parent keeps working. The mission can be
the durable ledger of delegated work. This is a valid composition if Laser
makes the relationship explicit.

### Where the two systems can diverge

#### 1. Two objectives can silently disagree

**Verified:** There is no current bridge that links a Goal ID to a mission ID,
copies objective edits, or reconciles terminal state.

Literal scenario:

```text
Laser Goal:   “Ship 0.3.0 with the relay disabled.”
Goal mission: “Ship 0.3.0 with the relay enabled after a security review.”
```

Editing the Laser Goal does not edit the mission. Updating the mission does not
edit the Goal. A goal-mission notice is inserted into the same parent session
that is being driven by the Laser Goal, so the model can receive instructions
about both without a machine-readable rule for which one governs.

**Possible treatments:** keep them visibly independent; allow a user to link
one mission to the current Goal; or remove “goal” from Laser's presentation of
mission continuation and call it a durable mission reminder.

#### 2. The budgets measure different work

**Verified:** The Goal budget is based on Goal-managed parent-session usage
after its baseline. The mission budget folds token totals from runs linked to
that mission. Neither is a shared account-wide or parent-plus-children cap.

Literal scenario:

```text
Laser Goal budget:          100,000 parent tokens
Goal-mission budget:        100,000 linked child tokens
Possible combined activity: nearly 200,000 tokens, before unrelated work
```

Displaying one of these as “the budget” would be misleading. If Laser keeps
both, it should label them as parent continuation and delegated-run budgets, or
introduce a Laser-owned aggregate budget that enforces a shared ceiling.

#### 3. Pause, stop, clear, and close affect different things

**Verified:** `/goal pause` stops automatic Goal continuation; it does not stop
detached subagents and does not pause a mission. Pausing a goal mission stops
its notices; it does not stop its active child. `/goal clear` does not close a
mission. Closing a mission does not complete or clear a Laser Goal.

Literal scenario:

```text
1. A Goal launches three background reviewers under a goal mission.
2. The person presses “Pause Goal” in Laser.
3. The parent stops continuing.
4. The three reviewers keep consuming tokens and editing unless separately stopped.
5. The mission remains open.
```

This is not necessarily incorrect—the controls operate on different objects—
but the UI must not imply that the Goal button is a fleet-wide emergency stop.

#### 4. Completion can split

**Verified:** `goal_complete` and `mission.close` have independent validation
and persistence. One can succeed while the other remains active.

Examples:

- The parent verifies the requested release and calls `goal_complete`, while a
  linked audit mission is still open because it records residual follow-up.
- A mission is closed as cancelled, while the session Goal remains active and
  automatically chooses another route.
- A mission hits `budget-exhausted`; the Goal has budget left and continues.
- The Goal hits `budget_limited`; detached mission runs continue until their
  own controls or budget stop them.

Laser must decide whether these are valid independent states or whether a
linked mode should define translations. Automatic translation is dangerous:
“Goal completed” does not always mean “all durable work may be closed,” and
“mission cancelled” does not always mean the user's objective is impossible.

#### 5. One Goal can receive notices from several goal missions

**Verified:** the mission collector scans all nonterminal goal missions owned
by the current session. Each idle active mission can produce a notice after the
parent's `agent_end`. `pi-goal` supports one current Goal.

Literal scenario:

```text
Current Goal: “Prepare the launch.”

Idle goal missions:
  A. Legal review
  B. Performance review
  C. Packaging review

After one parent turn, all three may report a next ready action into the one
Goal-driven conversation. There is no built-in priority or single-current-
mission rule.
```

This is powerful for a human coordinator and ambiguous for an automatic
single-objective driver. Possible policies include one linked goal mission at a
time, explicit mission priority, or presenting notices to the person without
putting every notice into the Goal's automatic decision stream.

---

## Automatic continuation and background subagents

### The basic race

**Verified:** an async `subagent` call returns after launch. The parent can then
finish its answer and settle while the child is still running. An active
`pi-goal` schedules another model turn after the parent session settles unless
it has reached a terminal/safety state or accepted `goal_wait`.

Literal timeline:

```text
T0  Parent Goal says: delegate the audit.
T1  subagent({ agent: "reviewer", task: "Audit the release.", async: true })
    starts child A and returns a run ID.
T2  Parent turn ends; child A is still working.
T3  Goal sees an incomplete objective and automatically continues.
T4  Parent may launch child B for the same audit or spend a turn polling.
T5  Child A completes and sends its normal completion notification.
```

The package does not force duplication—the model may inspect active work—but
the orchestration contract does not make “a required child is running” an
automatic wait state for `pi-goal`.

Foreground execution avoids this particular race because `async: false`
blocks the parent tool call until the child finishes. It also sacrifices
background concurrency and some extension/provider capabilities.

### The available complementary pattern

`pi-goal` provides `goal_wait` for exactly the case where progress depends on
an already-arranged external wake. pi-subagents' ordinary completion path sends
a `subagent-notify` message with turn triggering enabled by default.

A cooperative turn can therefore follow this pattern:

```text
1. Launch background child A.
2. Confirm that A has a native completion notification path.
3. Call goal_wait alone, with the exact current Goal ID.
4. Keep the Goal quiet.
5. Child A completes and its notification wakes the parent.
6. The parent consumes A's result and continues the Goal.
```

**Inferred risk:** This composition is supported by the separate semantics, but
there is no explicit pi-goal/pi-subagents adapter that guarantees ordering,
deduplicates wakeups, or declares the child run as the Goal's awaited resource.
It needs an end-to-end test in Laser for success, failure, stop, late delivery,
session reload, and simultaneous child completions.

A Laser-owned adapter could make this deterministic by storing an awaited run
ID on the Goal-to-run link and only resuming when that exact run becomes
terminal or needs attention. That adapter would not require replacing the
execution engine.

### There is no shared workflow mutex today

**Verified:** `pi-goal` implements the cooperative `workflow:mutex:v1` channel
in the `agent-workflow` group. Its documentation characterizes cooperation with
compatible `pi-plan-mode` versions on Pi 0.84.2. The inspected pi-subagents
0.65.1 source does not participate in that mutex, and Laser bundles Pi 0.85.0.

Therefore neither the mutex nor the feature flags prevent these from being
active together:

```text
pi-goal automatic parent continuation
pi-subagents workflowScript execution
pi-subagents goal-mission notices
detached child processes
```

This does not prove they interfere on every run. It means mutual exclusion is
not a current cross-package guarantee. If Laser wants “one autonomous workflow
owns this session at a time,” it must test the pinned Pi version and add a
coordinator, extend the mutex participants, or define which combinations are
allowed.

---

## Forked child sessions can inherit unrelated session state

**Verified:** `context: "fork"` creates a Pi branched session from the parent's
current leaf. The pi-subagents fork sanitizer removes unsafe provider-thinking
blocks and can prune content, but the inspected implementation has no
goal-specific filter for custom `goal-state` entries. `pi-goal` intentionally
restores its state from those entries across compatible branches. Background
children load the parent's ambient extensions unless an agent configuration or
capability ceiling prevents it; foreground children do not.

**Inferred risk:** a background fork-context child can receive both the parent's
Goal history and the `pi-goal` extension. Depending on the child's effective
tool policy and restore checks, the child may pause the inherited Goal because
required goal tools are unavailable, or a permissive custom agent may continue
the parent's Goal inside the child. Either outcome mixes the parent's lifecycle
with the child's assigned task.

Literal risk scenario:

```js
// Parent has an active Goal: “Ship the release.”
subagent({
  agent: "custom-worker-with-inherited-tools",
  task: "Only inspect the changelog and report omissions.",
  context: "fork",
  async: true
})
```

Expected child responsibility: inspect the changelog once.

Possible inherited state: an active `goal-state` entry saying “Ship the
release,” plus ambient `pi-goal`. The assigned child task and inherited Goal now
compete for authority.

This should be characterized before calling it a defect. Relevant mitigations
are narrow:

- deny `pi-goal` as a child ambient extension by default;
- strip `goal-state` entries from subagent forks unless explicitly requested;
- use fresh context for roles that only need a bounded task;
- define a Laser child-session contract that passes selected conversational
  context rather than a complete extension-state branch.

The same general issue applies to any branch-persistent extension state, not
only Goals. A product-owned fork filter is valuable even if upstream execution
is retained.

---

## Project configuration and trust boundary

This is the clearest present architectural contradiction.

**Verified in Laser:** the worker creates Pi settings with
`projectTrusted: false`, disables ordinary package/extension/skill/prompt/theme
discovery, and passes only validated `.laser` project values as in-memory
overrides. The product contract says `.pi` is not a Laser configuration or
migration source.

**Verified in pi-subagents:** parts of the package perform their own discovery
and persistence rather than relying only on Pi's resource loader. Its config
directory resolver defaults to Pi's project directory name, normally `.pi`.
The inspected source can directly use:

- `.pi/settings.json` for subagent settings and project-root policy;
- `.pi/agents/` and legacy `.agents/` for project agent definitions;
- package-provided agent, skill, prompt, chain, and extension declarations;
- `.pi/subagents/refinements/` for accepted agent refinements;
- `.pi/agent-memory/` for project-scoped agent memory;
- `.pi/WATCHDOG.md` for watchdog guidance;
- `.pi/subagents/schedules/` for scheduled-run records;
- `.pi/subagents/project-panes/` and `.pi/subagents/views/` for optional
  integrations.

Pi's `projectTrusted: false` protects Pi's own resource discovery. It does not
automatically intercept independent file reads inside an already-loaded
extension. Laser's `agentsFilesOverride` similarly controls Pi's agent/context
files, not pi-subagents' private discovery functions.

Literal verification scenario:

```text
project/
  .laser/
    settings.json        ← Laser-approved configuration
  .pi/
    settings.json        ← should be unsupported by Laser's product contract
    agents/worker.md     ← pi-subagents may discover this directly
```

If `worker.md` appears in a Laser subagent list or affects a run, the product is
executing project input from a location it claims not to support. This is a
trust and predictability issue, not merely a label problem.

Neutral implementation options:

| Option | Benefit | Cost or limit |
| --- | --- | --- |
| Hide/document the behavior | No engine work | Contradicts the current product boundary and can surprise users |
| Add an upstream config-root and trust-policy hook | Preserves native package and benefits other hosts | Requires upstream design and release timing |
| Register Laser-owned runtime agents and deny project discovery | Narrower adapter | Must prove every secondary path—settings, memory, refinements, watchdog, schedules—is also denied or redirected |
| Maintain a small patch/fork | Immediate deterministic behavior | Ongoing rebase, release, and security-review obligation |
| Replace orchestration | Full ownership | Reimplements a large mature surface and loses native compatibility unless carefully designed |

At minimum, Laser needs a test that puts conflicting definitions in `.laser`,
`.pi`, and `.agents`, then records exactly which settings, roles, skills,
extensions, memory, and watchdog instructions reach every launch mode.

---

## Extension, tool, and permission boundaries

### Ambient child extensions

**Verified:** foreground children never load the parent's ambient extensions.
Background children normally do, unless the agent declares extensions or an
out-of-band capability ceiling denies them. Custom roles may name additional
extension files and direct MCP configuration.

Laser, however, treats enabled Features as a curated product manifest. A user
can reasonably assume that the feature list defines what code and tools run.
Ambient or project-discovered child extensions can weaken that assumption.

The strongest compatible control is pi-subagents' capability ceiling,
especially `denyExtensions`, plus explicit agent definitions. It is a
same-process policy boundary, not an operating-system sandbox; trusted code
already running in the parent remains fully privileged.

### Child permissions are not automatically Laser approvals

pi-subagents supports child permission policies and a watchdog arbiter. Laser
has a person-facing permission and portable extension-dialog path. These are
different control planes.

Literal scenario:

```text
1. A detached child wants to run a mutation tool.
2. Its role says “ask” and the watchdog decides whether to allow it.
3. The person is looking at Laser's parent-session approval surface.
4. No equivalent user approval card appears unless Laser explicitly bridges it.
```

This may be acceptable for a pre-authorized autonomous role. It is not
acceptable if the product copy implies that every consequential action waits
for the person's approval. Laser must label autonomous policy honestly or route
child permission requests through a durable product protocol.

### External CLI agents

pi-subagents can delegate to external command-line agents such as Codex,
Claude, or Cursor when their executables and authentication are available.
That is useful in native Pi environments. It conflicts with Laser's “bundled
runtime; no terminal required” promise if shown as a ready product capability
without installation, authentication, version, output, and permission support.

The neutral choices are to hide unsupported external profiles, support them as
explicit integrations with preflight and setup UI, or declare them Advanced
and best-effort. Merely finding a binary on `PATH` proves neither authentication
nor compatibility.

---

## Product vocabulary and duplicate interfaces

pi-subagents is a Pi-native power-user package. It includes slash commands,
its own Fleet view, inspector, widgets, agent/model configuration, Herdr panes,
Orca progress tabs, doctor output, and terminal-oriented management flows.
Laser owns a different product language: runs, plans, ledgers, panels, Goals,
Features, desktop/phone placement, and capability-aware controls.

**Verified:** Laser currently collects registered extension commands and labels
non-Goal commands under Subagents. This can expose package and terminal
vocabulary that the product boundary otherwise tries to hide. Some commands
expect a TUI, an optional external application, or direct configuration files.

This produces three possible classes:

| Class | Example | Best treatment |
| --- | --- | --- |
| Same capability, different presentation | Upstream Fleet vs Laser run tree | Keep upstream logic; expose only Laser surface |
| Specialist feature with no Laser surface | Herdr/Orca configuration | Advanced/unsupported until deliberately integrated |
| Product-critical capability | stop, steer, resume, mission state | Promote to stable protocol and native Laser controls |

The package does not need to adopt Laser's nouns internally. The conflict
appears when raw commands or TUI assumptions leak into the normal product.
Laser can solve much of this with curation rather than a new execution engine.

### Headless and portable UI expectations

Laser binds Pi extensions in RPC mode and supplies a portable UI bridge. The
bridge can safely represent selection, confirmation, input, editing,
notifications, status, widgets, title changes, and editor text. It cannot
faithfully host every terminal `custom()` component.

pi-subagents includes TUI-rich views and management flows. A raw command can be
registered and discoverable even when its expected renderer or interaction is
not a Laser product surface. The safe outcomes are a native Laser equivalent,
a clear unavailable result, or cancellation. Hanging while waiting for an
invisible terminal component is unacceptable.

Literal scenario:

```text
1. Laser lists an upstream agent-management command.
2. The person invokes it from the desktop command menu.
3. The command opens a custom terminal editor that RPC mode cannot render.
4. Without a guard, the parent session waits for input the person cannot send.
```

Laser's existing portable bridge reduces this risk, and prepared upstream work
adds guards for custom interfaces. A first-class Subagents product should still
inventory every exposed command and classify it as native, portable, advanced,
or unavailable.

### Automatic missions can create product state without an explicit user act

**Verified:** an ordinary `workflowScript` creates one enclosing mission by
default. The caller can pass `mission: false`, and configuration can disable
automatic mission creation, but neither is the native default.

This is valuable for recovery. It can also make Laser's Missions surface fill
with records for short workflows the person considered ephemeral. The product
choice is whether every workflow deserves a durable ledger, whether Laser
should choose the default based on task class, or whether only user-named work
becomes a visible mission.

---

## Scheduling is storage plus a runner, not a daemon

**Verified:** pi-subagents schedules store recurring workflow definitions, but
nothing fires merely because a schedule exists. An external process must call
`schedule.run-due`. Current safe scheduling is fixed-interval; calendar forms
are deferred. Schedules normally live under the project config directory and
fresh scheduled runs do not automatically become a session Goal or mission.

Literal scenario:

```text
Monday: a user creates “run tests every 24h.”
Tuesday: the app was closed and no service called schedule.run-due.
Result: no run occurred. The stored next-run timestamp was not a daemon.
```

If Laser exposes schedule creation, its no-terminal product promise makes Laser
responsible for a real local scheduler lifecycle: start, wake, sleep, missed
runs, upgrades, project availability, notification, pause, and uninstall.
Otherwise the feature must explain that it only defines work for an external
runner. This is an ownership gap, not a flaw in the package's documented
contract.

---

## Observability and lifecycle mismatches

### Background is observable but poll-based

pi-subagents persists background status, events, results, controls, sessions,
and logs. This is why Laser can recover terminal-started work. The host polls
status files on a bounded interval, so state changes are not frame-level live.
The in-process bus adds immediate completions and selected status/control data,
but the file schema remains essential.

Consequences:

- “working” can be up to a polling interval stale;
- partial output is not the same as authoritative completion;
- malformed or half-observed files require last-good-state behavior;
- any upstream schema/identity change must be audited against Laser's parser;
- identical panel IDs across live-bus and file paths are an integration
  invariant that both sides must preserve.

Laser's assistant transcript also treats a tool `result` as terminal. Partial
subagent output must remain a UI-only artifact until `tool_execution_end`, or a
running child can appear finished.

### Foreground is less controllable

Foreground children execute in process and return directly, but the current
Laser integration has no equally authoritative foreground index or remote
control channel. Transcript attribution is useful after the fact and weaker
than a durable run record. Laser truthfully hides controls it cannot perform.

If first-class live foreground control is required, the choices are an upstream
public index/event surface, a companion hook around launch, or treating all
product-launched work as background even when the underlying package supports
foreground mode.

### Disabling a feature is not stopping work

**Verified:** removing Subagents from a new worker configuration removes its UI
and launch surface; already detached operating-system processes and their files
do not become retroactively cancelled. Similarly, closing a Laser window is not
necessarily a child stop.

Laser should distinguish:

```text
Disable future subagent use
Hide subagent surfaces
Stop this run
Stop every active run in this project
Forget terminal records
```

Combining those actions behind one toggle would be destructive and surprising.

### Resume depends on the owner

Steer, stop, and interrupt can use a durable control inbox. Resume requires the
live owning Pi session and the advertised bus method. A run visible from a
phone or recovered from disk can therefore be real but not resumable. This is a
capability fact Laser already models; a Laser-owned engine would only improve
it if it also owned durable resume semantics.

---

## Concurrent writers and worktree ownership

Laser's “one worker per project directory” invariant prevents two Laser worker
processes from owning the same parent project session. pi-subagents is designed
to launch additional child sessions and detached runners from that project.
Its session lease prevents two writers from corrupting one Pi session file; it
does not make simultaneous repository edits safe.

Literal scenario:

```text
Parent session edits packages/worker/src/driver.ts
Child A edits the same file in the same checkout
Child B runs a formatter across packages/worker/src
```

All three operations may be individually valid and collectively destructive.
The package provides worktree isolation, mutation declarations, workflow
structure, acceptance, and review tools, but not every free-form multi-agent
call automatically enforces single-writer repository ownership.

Laser can choose among:

- default same-checkout execution and make concurrency an expert concern;
- enforce one mutating lane per checkout while allowing parallel readers;
- default every concurrent writer to a worktree;
- require explicit file/domain ownership on each run;
- provide merge, inspect, discard, and cleanup UI before making worktrees the
  normal path.

Building a new subagent engine would not remove the underlying Git concurrency
problem. It would only let Laser enforce one chosen policy centrally.

---

## Models, cost, and account expectations

**Verified:** a child may inherit a model, use a role override, follow fallback
models, enable fast priority, or call an external provider. Laser's main chat
model picker therefore does not necessarily describe child execution.

Potential product mismatch:

```text
Main session header: Model A, normal priority
Scout role:         Model B, fast priority
Reviewer role:      Model C through a provider extension
External worker:    separate CLI account, cost unavailable
```

The correct response is not to force one model everywhere. It is to show the
effective child model and thinking level, distinguish measured from unknown
cost, and define which settings the person is actually controlling. Account
quota, Goal budget, mission budget, per-run cost, and external-provider cost
are separate meters unless Laser creates and enforces an aggregate policy.

---

## Persistence, identity, and portability

The current design intentionally has several stores:

| Store | Owner | Purpose |
| --- | --- | --- |
| Pi session JSONL | Pi | Conversation branches and custom entries, including Goal state |
| Background run directory | pi-subagents | Live/terminal run state, events, control inbox, result metadata |
| Mission store | pi-subagents | Project-durable delegated-work ledger |
| `.laser` | Laser | Supported project product configuration |
| Laser host/protocol state | Laser | Cross-worker discovery and product representation |

Multiple stores are not inherently wrong; they allow terminal interoperability
and crash recovery. The risks are identity drift and partial lifecycle updates:

- a child can finish after its parent worker exits;
- a mission can outlive the session Goal that motivated it;
- a run may be discovered from files before its live owner is reachable;
- a schema upgrade can leave older durable records;
- a terminal Pi using another agent directory can create work outside Laser's
  configured scan roots;
- branch or session moves can make ownership inference imperfect.

Laser should document which identifiers are canonical—session ID, run ID,
workflow ID, mission ID, Goal ID—and store explicit links rather than infer
relationships from directory time or display text where possible.

---

## Upgrade and packaging ownership

Laser pins both Pi and pi-subagents exactly, which makes the current behavior
auditable. It also means a package bump is an integration change, not an
ordinary dependency refresh.

The compatibility surface includes:

- executable TypeScript files exported by the package;
- background runner launch and environment propagation;
- file schema and status vocabulary;
- global symbol and event-bus names;
- RPC capability names;
- completion-notification ordering;
- agent/profile discovery rules;
- Goal and fork interaction;
- packaged desktop operation with an empty `PATH`;
- host/worker process-version replacement after an update.

A Laser-owned implementation would exchange upstream schema churn for permanent
ownership of all these behaviors. A fork would retain upstream behavior but add
rebase work. An adapter makes fewer promises but must keep probing capabilities
truthfully. None is maintenance-free.

---

## Conflict register

| Area | Finding | Class | Product impact if untreated | Likely remedy class |
| --- | --- | --- | --- | --- |
| Goal vs goal mission meaning | Same word, different scope and driver | Verified/product choice | Ambiguous objective and status | Vocabulary or explicit link model |
| Goal and mission budgets | Parent and child tokens are separate | Verified | Misleading limit/cost display | Aggregate policy or precise labels |
| Goal pause vs child stop | Pause does not stop detached runs | Verified | Continued work/cost after apparent pause | Separate controls or linked stop policy |
| Async Goal continuation | Parent can continue while child runs | Verified | Polling or duplicate delegation | `goal_wait` adapter and awaited-run link |
| Forked Goal state in child | Fork retains custom state; background loads ambient extensions | Inferred risk | Child may restore unrelated parent Goal | Fork filter or child extension denylist |
| `.pi` discovery | pi-subagents reads project resources independently | Verified | Violates Laser configuration/trust promise | Upstream hook, patch, or owned discovery |
| Child permissions | Watchdog policy differs from user approvals | Verified/product choice | User misunderstands authorization | Durable approval bridge or explicit autonomy |
| External CLI agents | Depend on ambient binaries/auth | Verified | Breaks self-contained expectation | Hide, preflight, or productize integration |
| TUI and slash surfaces | Upstream UI/config vocabulary can leak | Verified | Duplicate or unusable controls | Curated manifest and native Laser surfaces |
| Schedules | Require external `run-due` caller | Verified | “Scheduled” work never runs | Laser scheduler service or no normal UI |
| Foreground control | Weaker index/control contract | Verified | Inconsistent run management | Upstream event surface or background-only policy |
| File polling | Durable but not instant | Verified | Stale activity and complex dedup | Bus enrichment plus last-good file layer |
| Disable semantics | Feature toggle does not cancel processes | Verified | Hidden continuing work | Separate disable/hide/stop actions |
| Same-checkout writers | Session lease does not protect repo files | Verified | Conflicting edits | Mutation policy and worktree workflow |
| Model inheritance/overrides | Child model can differ from parent | Verified | Hidden cost/quality changes | Show effective model and policy source |
| Durable identity | Several stores and owner states | Verified | Orphans and inferred links | Canonical IDs and reconciliation |
| Upstream schema evolution | Laser parses exact pinned contracts | Verified | Breakage on upgrades | Pin audit and compatibility tests |

---

## Architectural paths available to the maintainer

### Path A — Keep pi-subagents unchanged and treat it as an expert feature

**Gains:** smallest engineering surface; full native behavior; easiest terminal
interoperability; fastest access to upstream features.

**Accepts:** `.pi` and package vocabulary, weaker product curation, separate Goal
and mission models, and capability differences between run modes.

**Best fit:** Laser intentionally exposes Pi-native power rather than promising
a fully closed product model.

### Path B — Keep the engine and build a strict Laser policy adapter

Laser would continue using pi-subagents for execution, sessions, workflows,
worktrees, missions, receipts, and controls, while owning:

- the allowed agent registry;
- extension/tool/model ceilings;
- `.laser` configuration translation;
- Goal-to-mission/run links;
- scheduler lifecycle;
- product commands and vocabulary;
- stable protocol DTOs and reconciliation.

**Gains:** retains most mature execution behavior while closing product gaps.

**Costs:** adapter complexity; some upstream behavior must be disabled or
overridden; direct private discovery may still require a hook or patch.

**Best fit:** execution semantics are acceptable, but the product boundary must
be stricter than the native package's defaults.

### Path C — Contribute host hooks upstream

Candidate general-purpose hooks include:

- project trust and config-root resolver;
- fork-entry filter;
- foreground run index and control events;
- scheduler storage/runner interface;
- permission/approval provider;
- explicit Goal/workflow mutual-exclusion participant;
- stable graph and lifecycle export.

**Gains:** one ecosystem contract; lower long-term divergence; useful to other
headless and graphical Pi hosts.

**Costs:** upstream design negotiation and release timing; Laser cannot assume a
hook exists before it is merged and pinned.

**Best fit:** gaps are host-general and upstream is willing to maintain the
seams.

### Path D — Maintain a narrow pinned fork or patch set

**Gains:** immediate control over critical boundaries without rewriting the
engine; precise release timing.

**Costs:** every upstream update becomes a merge and security audit; fixes can
diverge; users may see behavior different from native pi-subagents.

**Best fit:** a small number of well-isolated changes are product-critical and
cannot wait for upstream.

### Path E — Hybrid: upstream execution kernel, Laser-owned higher layers

Under this model Laser could use upstream only for bounded child launch,
session/worktree execution, and low-level control. Laser would own missions,
Goals, schedules, policies, and the public run graph. Conflicting upstream
subfeatures could be disabled in the curated configuration.

**Gains:** one coherent product domain without rebuilding model execution,
sessions, output contracts, and process supervision.

**Costs:** may require pi-subagents to expose a smaller supported kernel; some
features are tightly integrated and difficult to disable independently.

**Best fit:** Laser's differentiation is orchestration and experience, while
upstream remains the trusted executor.

### Path F — Build a Laser-owned subagent package on Pi

This would mean a reusable Pi-native package—not UI code importing Pi—that
defines Laser's child launch, policy, events, storage, missions, and controls.
`packages/pi-extension` would still translate it into the engine-neutral
protocol.

**Gains:** complete authority over `.laser` discovery, Goal semantics,
approvals, live events, durable IDs, scheduling, and product vocabulary; no
need to translate unsupported upstream concepts.

**Costs:** reimplementing or deliberately dropping a very large body of work:
foreground/background runners, nested delegation, model fallbacks, external
agents, capability ceilings, worktrees, leases, notifications, control inboxes,
workflow sandboxing, lanes, missions, receipts, acceptance, watchdog, schedules,
costs, inspectors, recovery, compaction behavior, and portability. Laser also
becomes solely responsible for adversarial validation and long-running process
reliability.

**Best fit:** the required product semantics cannot be expressed through stable
upstream hooks, and those semantics are important enough to justify owning an
orchestration engine indefinitely.

No path is automatically the unbiased default. The choice depends on whether
Laser's required differences are mostly presentation, mostly policy, or mostly
execution semantics.

---

## Evidence needed before choosing a path

The following compatibility suite would turn the highest-risk inferences into
facts:

1. **Feature matrix:** Goals only, Subagents only, both, and neither. Verify
   tools, commands, state restoration, worker restart, and UI capability lists.
2. **Async Goal race:** start an active Goal, launch one slow background child,
   omit `goal_wait`, and record whether the next automatic turn duplicates,
   polls, or correctly recognizes active work.
3. **Goal wait handoff:** repeat with `goal_wait`; test completion, failure,
   stop, needs-attention, two simultaneous completions, reload, and late result.
4. **Dual-objective test:** use different session-Goal and goal-mission
   objectives. Record notice ordering, prompt context, edits, pause, completion,
   close, and budget exhaustion.
5. **Multiple goal missions:** make three idle missions owned by one Goal-driven
   session and observe number, order, and effect of notices.
6. **Fork-state test:** with an active Goal, launch fresh/foreground-fork/
   background-fork children under restrictive and inherited tool policies.
   Inspect child `goal-state`, extension load, restored status, and turns.
7. **Project trust test:** put conflicting agent/settings/skills/extensions/
   `WATCHDOG.md` content in `.laser`, `.pi`, and `.agents`; test trusted and
   untrusted projects in every child mode.
8. **Approval test:** make a detached child request a consequential tool and
   determine whether Laser, the watchdog, both, or neither owns the decision.
9. **Schedule lifecycle:** create a due schedule, close Laser, restart after the
   due time, and document missed-run policy. Repeat without any external runner.
10. **Disable during work:** disable Subagents with foreground, background,
    nested, paused, and needs-attention runs. Verify visibility, cost, stop, and
    recovery semantics.
11. **Concurrent mutation:** run two same-checkout writers and then two isolated
    worktree writers. Verify conflict detection, handoff, merge, cleanup, and
    user recovery.
12. **Owner loss:** kill the parent worker while a child runs, then reopen from
    desktop and phone. Test observation, notification, stop, resume, and mission
    reconciliation.
13. **Budget accounting:** measure parent Goal, linked mission runs, unrelated
    child runs, nested runs, fast priority, and external CLI usage separately.
14. **Packaged clean machine:** launch from the unpacked desktop distribution
    with empty `PATH`, no global Pi, and no user package state. Exercise a real
    subagent after session creation, not merely module resolution.
15. **Pin upgrade replay:** preserve fixtures for status files, missions,
    notifications, graphs, Goal forks, and control messages; replay them before
    accepting any Pi, pi-subagents, or pi-goal bump.

### Decision thresholds

Evidence would support **retaining upstream with presentation curation** if the
high-risk cases are either absent or solved through public configuration and
capability ceilings.

Evidence would support **an adapter or upstream hooks** if execution and
recovery are sound but trust, Goal coordination, approvals, or lifecycle links
need explicit host policy.

Evidence would support **a narrow fork** if only a few localized missing hooks
block the product and upstream timing is unacceptable.

Evidence would support **a Laser-owned orchestration package** if several
product-critical requirements require invasive private patches, the required
semantics repeatedly oppose upstream design, and Laser is prepared to own the
full execution/recovery/security test matrix.

The current source inspection proves real boundary work is needed, especially
around project `.pi` discovery and the independence of Goals and goal missions.
It does not, by itself, prove that a complete rewrite is cheaper or safer than
a strict adapter, upstream hooks, or a hybrid.

---

# Part IX — Production recipes

## Recipe 1 — Fast diagnosis, one writer, independent review

**Best for:** a bug with an unclear location but a bounded expected fix.

```js
subagent({
  workflowScript: `
    const map = await runs.run("map", {
      agent: "scout",
      task: "Trace duplicate notification delivery. Return the first wrong state transition and exact source locations."
    });

    const fix = await runs.run("fix", {
      agent: "worker",
      task: "Implement the smallest fix supported by this scout report:\n" + map.output,
      acceptance: {
        level: "checked",
        evidence: ["changed-files", "commands-run", "validation-output", "residual-risks"]
      }
    });

    const reviews = await runs.all([
      {
        key: "correctness",
        agent: "reviewer",
        task: "Review the current diff for correctness. Scout context:\n" + map.output,
        context: "fresh"
      },
      {
        key: "coverage",
        agent: "reviewer",
        task: "Review whether tests cover the reproduced failure and fixed behavior.",
        context: "fresh"
      }
    ]);

    return { map, fix, reviews };
  `,
  async: true,
  globalConcurrencyLimit: 2,
  maxSubagentSpawnsPerRun: 4
})
```

Why it works: recon is cheap, only one child writes, and review does not inherit
the implementer's assumptions.

---

## Recipe 2 — Architecture decision check

**Best for:** a plan may conflict with earlier constraints.

```js
subagent({
  agent: "oracle",
  task: "Reconstruct the inherited architecture decisions. Check whether moving session search into the worker violates them. Recommend the smallest consistent design.",
  context: "fork",
  async: false,
  model: "openai-codex/gpt-5.6-sol:high"
})
```

Why it works: the oracle's forked context is the evidence. A fresh reviewer
would see code and docs but could miss decisions made earlier in the session.

---

## Recipe 3 — Parallel writers with safe isolation

**Best for:** independent package changes that can be merged separately.

```js
subagent({
  workflowScript: `
    const lanes = await runs.all([
      {
        key: "protocol",
        agent: "worker",
        task: "Add the validated protocol schema and round-trip tests.",
        worktree: true
      },
      {
        key: "docs",
        agent: "worker",
        task: "Update architecture and user documentation for the approved schema.",
        worktree: true
      }
    ]);
    return lanes;
  `,
  async: true,
  worktree: true,
  baseRef: "main",
  acceptance: {
    level: "checked",
    evidence: ["changed-files", "commands-run", "validation-output", "diff-summary"]
  }
})
```

Why it works: file ownership is physically separated, and each lane returns a
reviewable handoff rather than racing in one checkout.

---

## Recipe 4 — Research with source discipline

**Best for:** a time-sensitive technical comparison.

```js
subagent({
  agent: "researcher",
  task: "Compare the current stable browser APIs for local speech recognition. Use primary specifications and vendor documentation, state support gaps, and cite every compatibility claim.",
  async: true,
  context: "fresh",
  output: "speech-api-research.md",
  outputMode: "file-only"
})
```

Why it works: the researcher has a narrow web brief, durable output, and a clean
context. It requires the web-tool provider to be loaded.

---

## Recipe 5 — Continue the same child after review

**Best for:** preserve implementation context while correcting a concrete
finding.

```js
subagent({
  action: "resume",
  id: "worker-run-id",
  message: "The reviewer found that abort leaves the lease held. Fix that path, add the failing regression test, rerun the focused suite, and return updated acceptance evidence."
})
```

Why it works: the revived child retains its persisted history. Starting a new
worker would spend context reconstructing the same implementation.

---

## Recipe 6 — Bounded recurring audit

**Best for:** a periodic check driven by an external scheduler.

```js
subagent({
  action: "schedule.create",
  name: "weekly-dependency-audit",
  every: "1w",
  catchUp: "latest",
  overlap: "skip",
  workflowScript: `
    const report = await runs.run("audit", {
      agent: "reviewer",
      task: "Audit exact dependency changes and report only actionable compatibility or licensing risks.",
      context: "fresh",
      output: "dependency-audit.md",
      outputMode: "file-only"
    });
    return report;
  `
})
```

Why it works: the run is fresh, async, non-overlapping, durable, and bounded.
An external process must invoke `schedule.run-due`.

---

# Part X — Failure modes and judgment calls

## Common mistakes

| Mistake | Better choice |
| --- | --- |
| Launching many writers in one checkout | One writer, or isolated worktrees |
| Polling async runs in a loop | Trust native completion; use one status check or `bg_wait` when justified |
| Treating steer acknowledgment as obedience | Inspect later state and evidence |
| Using fork for every child | Fresh context for independent reviews and narrow tasks |
| Using fresh for decision-consistency work | Fork to preserve prior decisions |
| Setting `reviewed` as acceptance policy | Request checked/verified; reviewed is an outcome |
| Giving a child every ambient extension | Declare only needed tools/extensions |
| Assuming a role installs its tool provider | Load the extension that supplies the tool |
| Hard-blocking writer tools too early | Budget read/search tools or use generous mutation limits |
| Treating a stale status file as process death | Require runner/lease terminal proof |
| Resuming a stopped child | Interrupt when future continuation may matter |
| Assuming foreground detach survives reload | Use true background execution |
| Using old `chain` or `tasks` request shapes | Use WorkflowScript |
| Putting arbitrary shell in WorkflowScript | Use a reviewed named host resource or gate |
| Treating capability ceilings as OS isolation | Combine them with real process/filesystem sandboxing |
| Showing missing usage as zero | Preserve unknown with its reason |
| Exposing an unavailable control | Probe the exact path and capability |
| Sharing without reviewing the transcript | Treat share as a data-disclosure operation |

---

## Choosing the smallest correct orchestration

More agents are not automatically better.

Use no subagent when the parent already has the context and the task is one
short action.

Use one scout when discovery is the bottleneck.

Use one worker when the decision is settled and file ownership is clear.

Use one fresh reviewer when independence matters.

Use the oracle when accumulated decisions are the subject.

Use `runs.all()` for truly independent read-only work.

Use `runs.lanes()` for independent streams with ordered stages.

Use worktrees only when writers genuinely need to run concurrently.

Use a mission when work must survive beyond one run and retain decisions,
artifacts, and receipts.

Use a schedule only when an external runner will reliably call
`schedule.run-due`.

Use the watchdog when automatic boundary review is worth another model call.

---

# System summary

Pi provides a durable, programmable coding-agent session.

pi-subagents turns that session into a parent that can delegate to
other real Pi sessions, each with explicit identity, tools, model, context,
limits, evidence, persistence, and control.

Laser embeds both while keeping their implementation
plumbing out of the product. It watches live buses and durable files, translates
runs into a stable protocol, and renders them as a coherent desktop and phone
experience.

The architecture is not merely “Laser calls a few agents.” It is:

```text
Human intent
  → Laser product surface
  → engine-neutral protocol
  → one project worker
  → pinned Pi session runtime
  → pinned pi-subagents orchestration
  → child Pi sessions and external providers
  → events, files, evidence, missions, and controls
  → Laser panels, run trees, and remote follow-through
```

That separation is why terminal-started work can still appear on a phone, why
the UI can evolve without forking the agent engine, and why a subagent remains
a real inspectable session instead of an opaque background prompt.

---

## Source map for maintainers

### Exact pins

- `packages/worker/package.json`
- `packages/pi-goal/package.json`
- `packages/pi-extension/package.json`

### Pi 0.85.0

- `node_modules/@earendil-works/pi-coding-agent/docs/usage.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/prompt-templates.md`

The workspace's pnpm store places the exact package under a versioned
`node_modules/.pnpm/` directory.

### pi-subagents 0.65.1

- `README.md`
- `docs/agents.md`
- `docs/configuration.md`
- `docs/extension-api.md`
- `docs/missions.md`
- `docs/models.md`
- `docs/observability.md`
- `docs/tool-reference.md`
- `docs/watchdog.md`
- `docs/workflows.md`
- `src/extension/schemas.ts`
- `src/shared/types.ts`
- `agents/*.md`
- `prompts/*.md`
- `skills/pi-subagents/`
- `skills/council-mode/`

### pi-goal 0.54.4

- `README.md`
- `src/command.ts`
- `src/commands.ts`
- `src/lifecycle.ts`
- `src/persistence.ts`
- `src/prompts.ts`
- `src/runtime.ts`
- `src/run-protocol.ts`
- `src/settings.ts`
- `src/tool-policy.ts`
- `src/tools.ts`
- `src/workflow-mutex.ts`

### Laser

- `docs/architecture.md`
- `docs/product-boundary.md`
- `docs/ux-agent-work.md`
- `docs/ux-panels.md`
- `docs/upstream.md`
- `packages/worker/src/driver.ts`
- `packages/worker/src/drivers/stable-sdk.ts`
- `packages/pi-goal/src/index.ts`
- `packages/pi-extension/src/modules/goal.ts`
- `packages/pi-extension/src/modules/subagents.ts`
- `packages/host/src/subagents/`
- `packages/ui/src/components/subagents/`

When upgrading either pin, re-audit this guide against installed source. Pay
special attention to the execution schema, action list, legacy removals,
control semantics, scheduler limitations, and Laser's capability probe.
