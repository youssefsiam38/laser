# Ask Oracle

Status: **binding design for M24** (`PLAN.md` "M24 · Ask Oracle"; decision
D-348). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md). Depends on
[`model-profiles.md`](model-profiles.md) (`oracleProfileId`) and follows the
[`agent-tool-contract.md`](agent-tool-contract.md). Read
[`agents.md`](agents.md) §2 and [`environment-policy.md`](environment-policy.md)
first. The shape follows OpenHands' `ask_oracle`: a stateless one-shot call to
a stronger saved model that gets no history and no tools.

## The idea in one paragraph

`ask_oracle` lets the model that is doing the work ask a stronger model one
question in a fresh context. The Oracle sees the caller's agent instructions,
the question and only the context the caller chose to send. It has no tools,
no conversation history, no filesystem, and no way to change anything. It
answers once; the answer returns to the caller as a tool result. The caller's
own model, profile and session are untouched.

## Tool

```text
ask_oracle
  question      1–4 000 chars, required
  context[]     0–16 items, total ≤ 64 KiB after rendering
    { kind: "text",  label?, text }                 bounded excerpt the caller wrote or read
    { kind: "work",  ref: ProjectWorkRef }           exact revision; host renders a bounded summary + body window
    { kind: "repo",  ref: RepositoryStateRef | RepositoryChangeRef, paths?[] }  exact state; host renders a bounded diff or file window
  label?        the normal ≤25-char activity label
→ { answer, model: { profileId, provider, id }, truncated: [...ids] }
```

- The tool is read-only and idempotent for the caller; it is annotated so.
- `work` and `repo` refs resolve through the host authority under the
  caller's project and trust policy; a ref from another project is refused
  with the M21 wrong-project reason.
- Every rendered item carries a provenance line (`[from Spec "Login" rev 4]`,
  `[from commit 3f2a…, src/auth.ts L40–L90]`); over-budget items are cut at a
  boundary and listed in `truncated`.

## What the Oracle receives

1. A fixed Oracle system prompt owned by Laser: answer once, with reasoning,
   assumptions and alternatives; no tools exist; do not ask for more context —
   say what is missing.
2. The **caller's agent instructions**, rendered as the caller's session
   rendered them (D-175), minus `{{availableTools}}` and `{{toolGuidelines}}`
   — the Oracle has no tools and must not be told it does.
3. The context items with provenance lines, in the order given.
4. The question.

It does not receive: the conversation, prior tool calls or results, the
composer draft, files it was not handed, credentials, host paths, the fleet.

## Runtime

- Runs in the worker of the calling session as one bounded completion on
  `oracleProfileId`, walking the profile with the M22 eligibility classes; a
  timeout (`ORACLE_TIMEOUT_MS = 120_000`) and a max-output bound apply.
- No session, no agent run, no fleet row, no worktree. The call is a tool
  call in the caller's transcript like any other; its stored call keeps the
  rendered context digest, not the rendered bytes.
- The caller's turn waits like any tool call; the person may cancel the turn
  and the Oracle request is aborted with it.
- Thinking level comes from the profile entry.
- A Chat session, a project session and an agent run may all call it; a child
  agent calls it under its own instructions. Nesting is impossible by
  construction (no tools).

## What a person sees

- Transcript: one tool row "Asked the Oracle" with the question as summary,
  the answer expandable, the profile and effective model, and the context
  items listed by provenance. Truncation is stated.
- Logs: the provider request is visible like any other, tagged
  `purpose: "oracle"`.
- Usage: attributed to the calling session and to the Oracle model; the
  account-usage module marks it as a consultation.
- Settings → Providers and models → consultation profile picker (M22).
- If `oracleProfileId` has no usable model the tool returns an error the model
  can act on ("No consultation model is available; continue without it or ask
  the person to configure one") and the transcript row says the same.

## Security and policy

- The tool is exposed only when the environment's method policy allows
  `session_write` for the caller (it spends credit) and the caller's project
  is trusted for the refs it sends.
- Rendered context passes through the same escape path as any transcript
  content; no raw HTML, no executable content.
- A relay/phone client sees the row and the answer as data; nothing about the
  tool needs the phone.

## Affected areas

| Layer | Change |
| --- | --- |
| Protocol | `ORACLE_TOOL_NAME`, input/output schemas, annotations, `purpose: "oracle"` on log/usage records, `oracleProfileId` (M22), `SessionState` unchanged |
| Worker | `agents/oracle.ts` (prompt assembly, context rendering, profile walk, bounds) registered beside the harness tools; `agents/harness.ts` tool injection; `engine-instructions.ts` line telling agents when to consult; `pi-extension` account-usage tagging |
| Host | `project-work` bridge renders `work`/`repo` refs with bounded windows (M21-T4 reads); trust check |
| UI | `thread/ToolRow` variant for the Oracle row, provenance list, truncation notice; logs and usage labels; both widths and themes |
| Docs | `agents.md` §2 tool table, `product-boundary.md`, `transcript-reading.md` |
| Tests | prompt assembly excludes history/tools; over-budget truncation; wrong-project refusal; exhausted profile error; cancel aborts; stored call holds digest not bytes |
