# Workflow scripts: what to learn and what to replace

The central implementation is [scripted-workflow.ts](upstream/src/workflows/scripted-workflow.ts). Start with `runWorkflowScript` at line 1694, then its embedded `WORKER_SOURCE` at line 33. [subagent-executor.ts](upstream/src/runs/foreground/subagent-executor.ts) supplies launch/status/steering/admission/persistence callbacks. [workflow-settlement.ts](upstream/src/workflows/workflow-settlement.ts) decides truthful terminal outcomes.

These examples explain upstream mechanisms. They are not a second Laser authoring interface or an instruction to expose JavaScript to users. Our visual editor and model-callable operations must use one saved definition model and one execution service. Arbitrary JavaScript cannot be promised a lossless conversion into an editable visual graph.

## Current API surface

| Operation | Actual behavior | Important limit |
| --- | --- | --- |
| `runs.run(key, params)` | Starts one keyed child when called; returns an observed promise | Same key + equivalent parameters reuses that invocation's promise; incompatible parameters fail |
| `runs.all([{key, agent, task}, …])` | Parallel launch group; ordered result array | Not a dictionary keyed by child names; normal child failure rejects |
| `runs.lanes([{key, stages}, …])` | Concurrent lanes, sequential stages in each | Validates the whole bounded inventory before launch; failed lane skips later stages, siblings continue |
| `runs.steer(key, message, options)` | Sends to a child already launched under that workflow key | Receipt is queued/delivered/missed/failed; delivered means session accepted input, not model compliance |
| `runs.status(keyOrRunId)` | Queries host status | Status is not a wait primitive or proof of result acceptance |
| `runs.host(key, params)` | Host-executed command with bounded output/time | Public raw scripts cannot grant this; package-resolved resource authority is required |
| `state.get/set(key, value)` | Mission-backed JSON state via host callbacks | Unavailable without supplied state; no arbitrary filesystem access through this API |
| `emit(value)` | Produces validated JSON for persistence callback | An emit persistence failure fails the workflow; it is not a saved JavaScript continuation |
| `return value` | Final JSON value | No explicit return gives `null`; functions, cycles, non-JSON objects cannot cross the boundary |

Validation accepts a script statement body. It checks syntax, literal keys, obvious bad JSON boundaries, misuse of known `runs.all` arrays and unsupported nested async functions. Dynamic values still require runtime validation. `action: "validate"` does not launch agents or create run artifacts. `workflowScriptPath` is read by the host before execution; inline/path/named-resource forms are mutually exclusive.

## Recipes and their visual meaning

Agent names below refer to existing upstream definitions. In Laser, users choose their own saved agents and assign role labels.

### One worker

```js
const result = await runs.run("implement", {
  agent: "worker", task: "Implement the requested change."
});
return { runId: result.runId, output: result.output };
```

The equivalent direct upstream request is `{agent: "worker", task: "…"}`. Both should become the same launch contract in Laser. On the canvas this needs only two assignments and an authorized delegation connection; no separate runtime, framework selection or required planning ritual.

### Worker followed by validator

```js
const implementation = await runs.run("implement", {
  agent: "worker", task: "Implement the change and report evidence."
});
const validation = await runs.run("validate", {
  agent: "reviewer", context: "fresh",
  task: "Check this implementation and its evidence:\n" + implementation.output
});
return validation.output;
```

The sequence is a dependency; the passed output is a context binding. **This snippet alone does not transfer Git changes or guarantee the reviewer checks the worker's commit.** Laser must bind the validation assignment to the implementation result commit and evidence revision, then provide that committed state in its own worktree.

### Parallel independent checks

```js
const results = await runs.all([
  { key: "correctness", agent: "reviewer", task: "Check correctness." },
  { key: "tests", agent: "reviewer", task: "Check test coverage." }
]);
return results.map((result, index) => ({ index, output: result.output }));
```

One agent definition can supply two simultaneous assignments/sessions. The visual configuration needs fanout and a join rule. Source array order controls returned order; completion order can differ. Labeling the connection “review” is insufficient to define whether both checks must pass, one may finish first, or a failure cancels siblings.

### Bounded rework using structured decisions

```js
let feedback = "Implement the requested change.";
for (let attempt = 0; attempt < 3; attempt++) {
  const work = await runs.run("work-" + attempt, {
    agent: "worker", task: feedback
  });
  const check = await runs.run("check-" + attempt, {
    agent: "reviewer", task: "Evaluate:\n" + work.output,
    outputSchema: {
      type: "object",
      properties: {
        accepted: { type: "boolean" },
        feedback: { type: "string" }
      },
      required: ["accepted", "feedback"], additionalProperties: false
    }
  });
  if (check.structuredOutput.accepted) return { accepted: true, attempt };
  feedback = check.structuredOutput.feedback;
}
return { accepted: false, reason: "Rework limit reached" };
```

New keys identify new attempts. Do not reuse `work` with a different task and expect a retry. In Laser, “process succeeded,” “schema valid” and “outcome accepted” remain separate fields. Here, returning `{accepted:false}` is a successful script return; the product must explicitly map that value to an unmet requirement. A user-authored loop limit is a coordination condition, not a second `/goal` budget or continuation engine.

### Rolling exchange while a sibling works

```js
const writer = runs.run("writer", {
  agent: "worker", task: "Implement the change."
});
const evidence = await runs.run("evidence", {
  agent: "scout", task: "Find the precise interface contract."
});
const receipt = await runs.steer("writer", evidence.output, {
  mode: "follow_up"
});
return { result: await writer, receipt };
```

For rolling councils, upstream also supports observed `Promise.race` followed by collection with `Promise.all`. A race does not imply that losing children stopped. The script must handle remaining launches; workflow termination aborts remaining work through the child controller. Laser needs an explicit remaining-child disposition and a visible delivery receipt. Generic peer messaging must use our router; this upstream example is still parent-mediated steering.

### Independent sequential lanes

```js
return runs.lanes([
  { key: "api", stages: [
    { key: "write", agent: "worker", task: "Implement API changes." },
    { key: "challenge", resume: "previous", task: "Challenge your implementation." },
    { key: "review", agent: "reviewer", task: "Review API changes." }
  ] },
  { key: "ui", stages: [
    { key: "write", agent: "worker", task: "Implement UI changes." },
    { key: "review", agent: "reviewer", task: "Review UI changes." }
  ] }
]);
```

Generated child keys are `api.write`, `api.challenge`, etc. `resume: "previous"` requires retained run identity and uses existing resume admission; it is not permission to reopen an arbitrary session. Limits are 32 lanes, 16 stages per lane, 64 total stages and 64 KiB canonical inventory. An explicit structured `verdict: "blocked"`, failure, stop or detach blocks that lane; reviewer prose is not parsed. The board is bounded metadata, not all transcripts.

## Inside the engine

1. **Host starts a worker thread.** The embedded worker creates a Node VM context exposing `runs`, wrapped `Promise`, `emit`, captured console and optional state. String/Wasm code generation is disabled. This restricts exposed APIs; do not claim it is a complete security boundary for hostile code.
2. **Worker posts correlated calls.** Incrementing call IDs match responses; keyed launches also have stable workflow keys. Results are plain JSON projections, not host objects or private session paths as executable handles.
3. **Host admits before launching.** Batch admission runs once per group. A semaphore bounds concurrency. Launches recheck abort/stop after acquiring capacity. Host-only resource permits cannot be supplied by the model as trusted provenance.
4. **Duplicate keys are checked in memory.** Canonical parameter fingerprints let identical calls reuse a promise. This is invocation-level idempotency, not durable exactly-once execution across a process restart.
5. **Promise observation is tracked.** Proxies, native promise hooks and dependency tracking distinguish launched from awaited/returned work. Unobserved child/steer/host calls make successful completion fail. Nested async helpers are rejected for portability because native async behavior can hide observation, particularly across runtimes.
6. **Trace callbacks and durable effects differ.** Trace/lane/host-status callbacks are guarded so telemetry exceptions do not corrupt successful child results. `emit` persistence failures are fatal. Required evidence/receipt persistence failure also blocks accepted workflow completion.
7. **Finish aborts the child controller.** It waits for steer/host promises to settle, terminates the script worker and retains partial results/trace on failure. This is not proof that every OS child has exited; process supervision has its own settlement.

Laser should model operations as durable commands with explicit lifecycle instead of reproducing the complexity of observing arbitrary promise chains. The editor can represent dependencies, conditions, joins, messages, shared values and repeated attempts in one versioned definition. Advanced expression or custom capability support must still go through those same operations and policies; never a hidden second execution engine.

## Persistence, recovery and source/document discrepancies

[workflow-receipt.ts](upstream/src/workflows/workflow-receipt.ts) records a bounded terminal receipt with keyed children, run lineage, output references, resumability, resource provenance and host-step metadata. Reading is bounded to 2 MiB and validates versions/identity. Missing resumability is unknown/not resumable, not implicit permission. Receipts do not serialize the script VM or local variables.

**Critical source fact:** `promoteSettledPausedWorkflow` in [workflow-settlement.ts](upstream/src/workflows/workflow-settlement.ts) sets a settled paused workflow to failed when its JavaScript continuation was not persisted, even when the detached child succeeded. Its diagnostic explicitly requires workflow recovery. The upstream [workflow prose](upstream/docs/workflows.md) says a detached child's eventual exit reconciles the workflow to complete or failed; that prose must not be read as a guarantee of transparent continuation.

An acceptance-metadata failure can retain a useful child report under `available-for-review`. The script runtime erects a recovery barrier: later mutation, state writes, host commands and steering are rejected, while an explicit read-only recovery review may proceed. Its read-only classifier includes extensive prose heuristics. **Laser should enforce recovery privileges through actual capability policy**, not infer authorization from a task sentence.

Named resources are also narrower than their name suggests: the pinned resolver contains package-owned `review` and `run-ci`, not a general user/project workflow registry. Raw equivalent script text does not inherit a named resource's host-command permit.

## Our persistence requirement

Persist definition revision, operation/attempt IDs, dependencies, input/resource revisions, selected commits, admitted launch intents, result references, receipts and the next eligible transitions. Recover from that record; do not rerun a script from its beginning hoping identical keys will be reused. An uncertain launch must be reconciled before retry. A required evidence write must complete before reporting accepted success. The single `/goal` owner determines objective continuation; workflow execution does not start a competing objective loop.
