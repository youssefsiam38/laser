# Agent-to-agent architecture

## The simple rule

Expose one generic tool named `start_agent`.

Do not create a different tool for every available agent. Another agent may be
a specialist, a faster worker, an independent reviewer, or a more capable model
performing a larger task.

The main model receives a compact catalog containing each agent's `agent_name`
and short description. The harness keeps the complete instructions and
configuration private until that agent is started.

## Names and identities

Use only these four identity fields:

```json
{
  "agent_name": "reviewer",
  "subagent_name": "review-auth-refresh",
  "sessionId": "session_42",
  "runId": "run_7"
}
```

- `agent_name` is the unique name of the reusable agent definition. It is also
  that definition's ID. Do not add a separate agent ID, type, or profile name.
- `subagent_name` identifies the running instance created for this piece of
  work. Multiple instances may use the same `agent_name`.
- `sessionId` identifies the persistent conversation. Use it to send another
  message to the same agent later.
- `runId` identifies one execution inside that session. Use it to wait for,
  stop, or correlate that particular execution.

Example:

```text
agent_name: reviewer
├── subagent_name: review-auth-refresh
└── subagent_name: review-auth-permissions
```

## What the main model receives

The AI provider request contains one tool:

```json
{
  "name": "start_agent",
  "description": "Start another agent for an independent piece of work. Available agents: explorer — codebase research; worker — implementation; reviewer — independent verification.",
  "parameters": {
    "type": "object",
    "properties": {
      "agent_name": {
        "type": "string",
        "description": "The unique name of the reusable agent to start."
      },
      "subagent_name": {
        "type": "string",
        "description": "A short name for this running instance and its task."
      },
      "task": {
        "type": "string",
        "description": "The complete task and all context the new agent needs."
      }
    },
    "required": ["agent_name", "subagent_name", "task"]
  }
}
```

Only each agent's `agent_name` and short description belong in the compact
catalog. Do not put every agent's system instructions, tools, or model
configuration in the main request.

## Starting an agent

The main model calls the same tool for every agent:

```js
start_agent({
  agent_name: "reviewer",
  subagent_name: "review-auth-refresh",
  task: "Review the authentication changes. Test them and report concrete problems."
})
```

The harness then:

1. Validates that `reviewer` exists and is allowed.
2. Loads that agent definition's full system instructions, model, thinking
   level, tools, skills, and allowed child agents.
3. Creates a persistent child session.
4. Creates its isolated worktree under `.worktrees/`.
5. Starts the child model loop in the background.
6. Immediately returns the session and run identities.

```json
{
  "agent_name": "reviewer",
  "subagent_name": "review-auth-refresh",
  "sessionId": "session_42",
  "runId": "run_7",
  "status": "running"
}
```

`start_agent` never waits for completion. The parent can continue working or
start other agents.

## What the child model receives

The child receives its own provider request and context window:

```json
{
  "system": "You are an independent reviewer. Verify claims and report evidence...",
  "model": "the model configured for reviewer",
  "tools": ["read", "grep", "bash", "complete_agent_run"],
  "messages": [
    {
      "role": "user",
      "content": "Review the authentication changes. Test them and report concrete problems."
    }
  ]
}
```

The child does not need the parent's entire conversation. The `task` must be
self-contained. Include selected parent context only when it is needed.

## Completing work and reporting the result

Every child receives one mandatory terminal tool named
`complete_agent_run`:

```json
{
  "name": "complete_agent_run",
  "description": "Finish the current run and publish its final message.",
  "parameters": {
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "enum": ["completed", "blocked"]
      },
      "message": {
        "type": "string",
        "description": "The final result, evidence, and any important next step."
      }
    },
    "required": ["status", "message"]
  }
}
```

Example child call:

```js
complete_agent_run({
  status: "completed",
  message: "Found one refresh-token reuse bug and added a regression test."
})
```

The harness handles this call mechanically:

1. Stores `message` as the child's normal final assistant message, so the
   child session reads like a complete chat.
2. Marks `runId` terminal and immediately stops the child model loop. The
   child must not produce another final message.
3. Emits a structured event to the parent containing the same message and the
   identities needed to continue the conversation.
4. Lets the UI render the stored message and run state. The tool submits data;
   it does not directly control presentation.

Example event:

```json
{
  "type": "agent.completed",
  "agent_name": "reviewer",
  "subagent_name": "review-auth-refresh",
  "sessionId": "session_42",
  "runId": "run_7",
  "message": "Found one refresh-token reuse bug and added a regression test."
}
```

The parent receives this event at the next safe model boundary. The UI renders
the stored message only once, inside the child session, and separately shows
the child's updated state to the parent.

Do not rely on arbitrary last text to detect completion. A successful run must
end through `complete_agent_run`. If the process crashes, is cancelled, or
times out, the harness records `failed`, `cancelled`, or `timed_out`
itself. Those states are not chosen by the model.

## Continued communication

An agent is a persistent, addressable session:

```js
send_agent_message({
  sessionId: "session_42",
  message: "Also check whether refresh tokens are rotated.",
  interrupt: false
})
```

```js
list_agents()
```

```js
wait_for_agents({ runIds: ["run_7"] })
```

```js
stop_agent({ runId: "run_7" })
```

`send_agent_message` uses `sessionId` because it addresses the persistent
conversation. Waiting and stopping use `runId` because they target one
execution. Sending a message to an idle session creates a new run and returns
its new `runId`.

## The reusable agent definition

The harness stores one definition for each `agent_name`:

```ts
type AgentDefinition = {
  agent_name: string;           // Unique name and ID.
  description: string;          // Shown in the compact catalog.
  systemInstructions: string;   // Loaded only for this agent.
  model: string;
  thinkingLevel?: string;
  tools: string[];
  skills?: string[];
  allowedAgents: string[];
};
```

The description answers, "When should another agent start this agent?" The
system instructions answer, "How should this agent perform its work?"

## Required behavior

- Use one `start_agent` tool, not one tool per available agent.
- Use `agent_name` as the unique name and ID of the reusable definition.
- Use `subagent_name` for the running instance. Do not add a separate agent
  ID, type, or profile name.
- Treat every started agent as a persistent child session.
- Run every child in the background and return `sessionId` and `runId`
  immediately.
- Give every child a separate worktree under `.worktrees/`.
- Require `complete_agent_run`; store its message as the child's normal final
  chat message and notify the parent with a structured event.
- Allow follow-up messages while the child is running or after it finishes.
- Put only compact discovery metadata in the parent request.
- Load the selected agent's full configuration only in the child request.
- Enforce nesting limits, model access, and worktree ownership in the harness,
  not through prompt instructions alone.
