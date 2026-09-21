# M23-T4 UI plan (remove Beam, plain Chat entry points)

Owner: worker agent "Plain chat UI and CLI", branch
`agents/plain-chat-ui-and-cli-26bc7136`, base `64cff8db`. Contract:
[`docs/plain-chat.md`](../plain-chat.md), `PLAN.md` "M23 · Plain Chat" row
M23-T4. Backend half (M23-T1/T2 in the base, M23-T3 concurrent on
`agents/plain-chat-backend-67bf3cde`) is described in
[`m23-backend-plan.md`](m23-backend-plan.md).

Write scope: `packages/ui`, `packages/cli`, `scripts/browser-check` (Beam
fixtures only), this file. Nothing else.

## Shape decisions (where the contract is silent)

- **D-t · a new Chat is `session/new { cwd: workspaces.chat, sessionKind:
  "chat" }`.** `agentName: "chat"` is gone with the built-in, and the protocol
  refuses the two together. `NewSessionOptions` therefore carries
  `sessionKind`, the launcher keys its reuse on `cwd + agent + sessionKind`,
  and `creationTargetForDestination` returns a session kind instead of an
  agent name for the Chat landing.
- **D-u · session rows group on `sessionKind`, not on the workspace
  directory.** `SessionAgentInfo.sessionKind` is the host's answer and wins;
  a session with no record falls back to "is its cwd inside
  `workspaces.chat`". A legacy record that still says `kind: "beam"` is read
  as a Chat session by the protocol's `sessionKindOf`, so old Beam
  conversations list in the Chat tab with no mark of their own.
- **D-v · the third entry point is `Mod+Shift+N`.** The contract asks for a
  keyboard shortcut that starts an empty Chat; `Mod+N` already means "new
  session in this project". `Mod+Shift+N` is its Chat counterpart, listed in
  Settings → Keyboard beside it and shown on the palette row.
- **D-w · the Agents page keeps the shipped `default` agent in "Your
  agents".** It is an ordinary editable definition (`kind: "custom"`), not a
  built-in. The designed empty state appears when the person has written no
  agent of their own *beside* it, which is the state the contract means by
  "explains how to write one".

## What changed

(kept current as work lands — see the checkpoints at the end)

## Deliberate survivors of the `beam` grep

## Depends on the host (M23-T3)

## For the docs and gates owner (M23-T5)
