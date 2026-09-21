# M23 · what the backend removal leaves red in `packages/ui`

For the M23-T4 owner. Written by the backend half (M23-T1–T3, branch
`agents/plain-chat-backend-67bf3cde`). Contract: [`../plain-chat.md`](../plain-chat.md),
decision D-347; the backend's own notes are in
[`m23-backend-plan.md`](m23-backend-plan.md).

`packages/cli` and `packages/desktop` are **not** red: both build and
typecheck clean after the removal, and the "beam" they mention is the
startup-screen drawing, which stays.

## The state of the tree

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/{protocol,worker,host,cli,desktop,pi-extension} typecheck` | clean |
| `pnpm -F @lasercode/ui typecheck` | 50 errors, listed below |
| `pnpm -r build` | everything but `packages/ui` builds |
| `pnpm -F @lasercode/cli test` | 18 files / 96 tests pass |

## What changed under the UI

1. `AgentKind` is `"custom"` only. `BUILTIN_AGENT_NAMES`, `BuiltinAgentName`,
   `isBuiltinAgentName`, `BuiltinProfiles` and `BuiltinInstructionOverrides`
   are gone. `RETIRED_AGENT_NAMES` / `isRetiredAgentName` remain for the one
   surviving purpose: a definition a person wrote before M23 that still names
   `beam`, `chat` or `namer` in `allowedAgents`.
2. `AgentsSnapshot` loses `builtinProfiles` and `builtinInstructions`;
   `workspaces` is `{ chat: string }`.
3. `agents/builtin/set-profile` and `agents/builtin/set-instructions` are gone
   from the protocol entirely — not refused, absent.
4. `SessionAgentKind` is `"root" | "child" | "chat"`. `SessionAgentInfo` gains
   a required `sessionKind: "chat" | "project"` and its `agentName` is now
   **optional** (a Chat runs no definition). `sessionKindOf(kind)` maps a
   stored `"beam"` to `"chat"`; a stored record is never rewritten.
5. `session/new` takes `sessionKind?: "chat" | "project"`. A plain chat is
   `{ cwd: <chat workspace>, sessionKind: "chat" }` with **no** `agentName`;
   sending both is refused by the schema.
6. The instruction-template catalogue lost its target: `instructionTemplateFields()`,
   `instructionTemplateIssue(template)`, `instructionTemplateFieldRanges(template)`
   and `renderInstructionTemplate(template, values)` take no target argument,
   and the Beam state-location fields plus `{{sourceText}}` are gone.

## The 50 errors, by file

`beam/*` and `BuiltinPanel.tsx` are being deleted by M23-T4, so most of these
disappear rather than get fixed.

### Deleted with Beam (`components/beam/*`)

| File:line | Symbol |
| --- | --- |
| `src/components/beam/BeamEmptyState.tsx(29,54)` | `AgentsSnapshot.builtinProfiles` |
| `src/components/beam/BeamProfileDialog.tsx(62,36)` | `workspaces.beam` |
| `src/components/beam/BeamProfileDialog.tsx(63,29)` | `AgentsSnapshot.builtinProfiles` |
| `src/components/beam/BeamSessionMark.tsx(13,7)` | `SessionAgentKind === "beam"` |
| `src/components/beam/beam-model.ts(45,29)` | `SessionAgentKind === "beam"` |
| `src/components/beam/beam-model.ts(46,93)` | `workspaces.beam` |
| `src/components/beam/beam-model.ts(51,36)` | `workspaces.beam` |

### Agents page (built-in panel, editor, template editor)

| File:line | Symbol |
| --- | --- |
| `src/components/agents/page/BuiltinPanel.tsx(7,108)` | `BuiltinAgentName` |
| `src/components/agents/page/BuiltinPanel.tsx(55,32)` | `AgentsSnapshot.builtinInstructions` |
| `src/components/agents/page/BuiltinPanel.tsx(75,57)` | `instructionTemplateIssue(text, target)` — one argument now |
| `src/components/agents/page/BuiltinPanel.tsx(242,30)` | `AgentsSnapshot.builtinProfiles` |
| `src/components/agents/page/dialogs.tsx(7,15)` | `BuiltinAgentName` |
| `src/components/agents/page/dialogs.tsx(96,25)`, `(97,31)`, `(115,16)` | `copy` possibly undefined (falls out of the `BuiltinAgentName` record) |
| `src/components/agents/page/model.ts(10,3)` | `BUILTIN_AGENT_NAMES` |
| `src/components/agents/page/model.ts(16,3)` | `isBuiltinAgentName` |
| `src/components/agents/page/model.ts(25,8)` | `BuiltinAgentName` |
| `src/components/agents/page/model.ts(166,15)`, `(167,18)`, `(273,55)` | inference fallout from the three above |
| `src/components/agents/page/AgentEditor.tsx(165,103)` | `instructionTemplateIssue(text, target)` |
| `src/components/agents/page/AgentList.tsx(35,11)` | `Icon` not callable — fallout from `page/model.ts` |
| `src/components/agents/page/InstructionTemplateEditor.tsx(7,8)` | `InstructionTemplateTarget` |
| `src/components/agents/page/InstructionTemplateEditor.tsx(74,44)` | `instructionTemplateFields(target)` — no argument now |
| `src/components/agents/page/InstructionTemplateSource.tsx(3,15)` | `InstructionTemplateTarget` |
| `src/components/agents/page/instruction-template-model.ts(6,8)` | `InstructionTemplateTarget` |
| `src/components/agents/page/instruction-template-model.ts(34,52)` | `instructionTemplateFields(target)` |
| `src/components/agents/page/instruction-template-model.ts(35,49)` | `instructionTemplateFieldRanges(text, target)` |

### Agent state and actions

| File:line | Symbol |
| --- | --- |
| `src/agents/actions.ts(26,3)` | `BuiltinAgentName` |
| `src/agents/actions.ts(156,17)`, `(156,51)` | `agents/builtin/set-profile` is not a method |
| `src/agents/actions.ts(160,15)`, `(160,49)` | `agents/builtin/set-instructions` is not a method |
| `src/agents/hooks.ts(128,5)` | selector returns an object missing the new `sessionKind` |
| `src/agents/model.ts(13,3)` | `isBuiltinAgentName` |
| `src/agents/model.ts(33,35)` | `workspaces.beam` |
| `src/agents/model.ts(50,3)` | `SessionAgentKind` no longer has `"beam"` |
| `src/agents/model.ts(79,10)` | `kind === "builtin"` |

### Shell, sidebar, destinations and settings

| File:line | Symbol |
| --- | --- |
| `src/components/assistant-ui/elements/thread-list.aui.tsx(1240,26)` | `agent.kind === "beam"` → `agent.sessionKind === "chat"` |
| `src/components/shell/GlobalSearch.tsx(50,20)` | `agent.kind === "beam"` |
| `src/components/shell/session-groups.ts(158,22)` | `agent.kind === "beam"` |
| `src/runtime/main-destination.ts(248,41)`, `(259,41)`, `(269,7)` | `agent.kind === "beam"` |
| `src/runtime/LaserProvider.tsx(1881,117)` | `workspaces.beam` |
| `src/components/mobile/DictateButton.tsx(76,48)` | `workspaces.beam` |
| `src/components/settings/models/ModelProfilesTab.tsx(189,91)` | `AgentsSnapshot.builtinProfiles` |
| `src/components/settings/models/profile-usage.ts(18,8)` | `BuiltinProfiles` |

## Three things worth knowing before fixing them

- **A Chat row carries no agent name.** `summary.agent` for a chat is
  `{ kind: "chat", sessionKind: "chat" }` — every `agent.agentName` read needs
  a fallback, and a row should test `sessionKind === "chat"`, not a name.
- **The "used by" line on a profile** (`profile-usage.ts`,
  `ModelProfilesTab.tsx`) now has three kinds of user: the three assignments
  and the person's agent definitions. Built-ins are not one of them.
- **Starting a chat** is `session/new { cwd: snapshot.workspaces.chat,
  sessionKind: "chat" }`. The host allocates the private folder; a request
  that also names an agent is refused with
  `"A chat runs no agent. Open a session in a project to start one."`.
