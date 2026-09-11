# Upstream contributions log

Every PR or issue filed against an upstream project, with its status. Keep PRs
small and self-contained (`AGENTS.md` §6).

| Project | Change | Task | URL | Status |
| --- | --- | --- | --- | --- |
| pi-subagents | export `requestAsyncSteer` / `requestAsyncInterrupt` from `./control-channel` | M3-T9 | — | moot after D-140; kept as history |
| pi-subagents | emit `workflowGraph` snapshot from scripted workflows | M3-T9 | — | moot after D-140; kept as history |
| pi-subagents | live index of running foreground children | M3-T9 | — | moot after D-140; kept as history |
| pi-subagents | guard `ctx.ui.custom()` call sites on `ctx.mode === "tui"` so RPC hosts get the `select` fallback | M3-T9 | — | moot after D-140; kept as history |
| pi-gpt-transcribe | non-tui entry point for hosts that provide the widget contract | M8-T2 | — | not filed |
| earendil-works/pi | `SettingsManager.applyOverrides()` is not durable: `reload()` and `setProjectTrusted()` recompute settings from the two files and drop it, and `createAgentSessionServices()` reloads the resource loader (hence settings) before the session exists. Fix: retain applied overrides and re-merge them after every recompute, or expose a hook to re-apply. Local workaround: `packages/worker/src/settings-overrides.ts`. | M13-T12 | — | not filed |
| earendil-works/pi | `dist/main.js` → `dist/experimental/server.js` imports `@earendil-works/pi-server`, undeclared in `package.json`; resolves only under npm's flat hoisting, fails under pnpm/strict installers with ERR_MODULE_NOT_FOUND. Fix: declare the dependency (or lazy-import the experimental server). Local workaround: `packageExtensions` in `pnpm-workspace.yaml`. | M0-T4 | — | not filed |
| earendil-works/pi | `ExtensionAPI.sendMessage` / `sendUserMessage` return `void`, so neither an extension nor a host embedding the SDK can observe whether a send was accepted or refused; the underlying promise is swallowed and a rejection reaches only `emitError`. Fix: return the operation promise from the loader API and the core binding, and widen `SendMessageHandler` / `SendUserMessageHandler` to `Promise<void>`. Local patch: `patches/@earendil-works__pi-coding-agent@0.85.0.patch`. | M13-T93 | — | not filed |
| earendil-works/pi | Opt-in durable zero-message sessions and append-scoped admission transactions: explicit `SessionManager.flush()`, deferred append commit/rollback, and saved runtime settings counting as existing session state. Local exact-version patch: `patches/@earendil-works__pi-coding-agent@0.85.0.patch`; generic proposal: `/tmp/laser-m13-t108-upstream-proposal.md`. | M13-T108 | — | pending parent review; not filed |
| pi-mcp-adapter | `index.ts`, `mcp-output-guard.ts` and others import `@earendil-works/pi-coding-agent` (and, through it, `@earendil-works/pi-ai`) as value imports without declaring either as a dependency or a peer; under pnpm they resolve only by accident of directory layout. Fix: declare them. Local workaround: `packageExtensions` in `pnpm-workspace.yaml`. | M14-T2 | — | not filed |
| pi-mcp-adapter | The package entry is executable TypeScript (`"types"`/`"import"` → `./index.ts`) and only four small modules are compiled to `dist`. Node refuses type stripping under `node_modules`, so any consumer that is not itself running a TypeScript loader cannot `import("pi-mcp-adapter")`: `createMcpAdapter`, `McpServerManager` and the OAuth flow are unreachable. Fix: compile the public surface into `dist` and point `exports` at it (keeping `pi.extensions` on the source for the engine's own loader), and export `server-manager` and `mcp-auth-flow` as subpaths. Local workaround: `packages/worker/src/mcp/engine.ts` loads them through jiti, the same loader the engine uses for extensions. | M14-T2 | — | not filed |
| pi-mcp-adapter | The host-config importers (`loadImportedConfig`, `extractServers`) are private, so only `findAvailableImportConfigs` (paths, no contents) is reusable. A host that offers its own import UI has to re-read Claude Code/Cursor/VS Code/Codex/OpenCode files itself. Fix: export a read-only `readImportedServers(kind, cwd)`. Local workaround: `packages/worker/src/mcp/import.ts` reads the files the engine located. | M14-T2 | — | not filed |

---

## Prepared patches

### pi-goal · host-owned usage policy and literal objectives (M12-T67)

Local exact-version patch: `patches/@narumitw__pi-goal@0.54.4.patch`, applied
through pnpm. It removes goal budgets, disables goal accounting, and parses
objectives as literal task text rather than shell tokens. Continuation safety,
completion termination and persistence remain upstream-owned. The source-map
files are upstream originals; review the patched executable chunks when tracing
this policy. Covered by `packages/pi-goal/test/policy.test.ts` against the actual
installed dependency. No upstream PR filed; a future contribution should expose
a host policy for accounting and preserve objective text, rather than impose
Laser's budget-free product choice on all upstream users.

Written and reviewed here, **not filed**. Each is small, self-contained, and
justified on the upstream project's own terms (extensibility, headless-host
support) — never on ours. Nothing about laser appears in a patch, a commit
message or a PR body.

### pi-coding-agent · durable empty sessions and append admission (M13-T108)

**Against:** `github.com/earendil-works/pi` @ 0.85.0. Local exact-version patch:
`patches/@earendil-works__pi-coding-agent@0.85.0.patch`, applied through pnpm.

A headless SDK host may need a newly allocated session identity to survive before
an assistant message exists, and may need to stage runtime setup until an
external prompt-admission decision. The local patch adds opt-in
`SessionManager.flush()` and a single append-scoped transaction. Rollback changes
no durable byte; commit verifies the exact baseline and atomically replaces it
with baseline plus the accepted suffix. A failed commit retains that suffix in
the same manager for one ordered retry, then fails closed. Structural operations,
including summary branches, are refused before mutation while a transaction is
active. Pi's default remains lazy. SDK construction also treats saved
model/thinking entries as existing zero-message state, so resume does not append
another initialization tuple.

Direct policy tests live in
`packages/worker/test/session-manager.transaction.test.ts`; Stable integration
and real-host lifecycle tests cover refusal, setup writes, cancellation,
acceptance, failure, worker retirement and host restart. The generic proposal
and diff evidence are in `/tmp/laser-m13-t108-upstream-proposal.md`.

**Status: pending parent review; not filed.** The parent owns any public issue or
PR after reviewing this seam.

### pi-coding-agent · awaitable extension sends (M13-T93)

**Against:** `github.com/earendil-works/pi` @ 0.85.0. Local exact-version patch:
`patches/@earendil-works__pi-coding-agent@0.85.0.patch`, applied through pnpm.

**The problem, in the project's terms.** `ExtensionAPI.sendMessage` and
`ExtensionAPI.sendUserMessage` are declared `void`, but the work they start is a
promise. `AgentSession.sendCustomMessage` and `AgentSession.sendUserMessage` are
`async`, and the operation behind them can be refused outright: `prompt()`
throws while a compaction is in progress, throws when the agent is already
processing and no `streamingBehavior` was given, and throws when no model is
selected. The core binding in `dist/core/agent-session.js` discards that promise
with `.catch()`, converting every refusal into an `emitError` diagnostic, and
the loader in `dist/core/extensions/loader.js` drops the return value on its way
out to the extension.

For a terminal user that is the right default: the error is printed and the
prompt carries on. For an extension — and for a headless host embedding the SDK
— it makes every send fire-and-forget. There is no supported way to await
delivery, to sequence a second send after the first has been accepted, or to
distinguish "accepted" from "refused" other than by subscribing to the error bus
and matching on an `event` string and a message text. An extension that must not
continue until its message is actually in a queue cannot find out that it never
arrived.

**The change.** Return the operation instead of discarding it, in the three
places that already hold it:

- `dist/core/extensions/loader.js` — `return runtime.sendMessage(…)` and
  `return runtime.sendUserMessage(…)` rather than calling and dropping;
- `dist/core/agent-session.js` — `bindCore` keeps the promise, attaches the same
  `emitError` diagnostic as a non-replacing `then(undefined, …)` handler (inside
  a `try`/`catch`, so a failing diagnostic cannot mask the original rejection),
  and returns the promise;
- `dist/core/extensions/types.d.ts` — `SendMessageHandler` and
  `SendUserMessageHandler` return `Promise<void>` instead of `void`.

**Why it is safe for existing callers.** A returned promise is ignorable. Every
call site that ignores the result today behaves exactly as it did: the
diagnostic still fires, nothing new throws synchronously, no argument or
overload changes, and a `Promise<void>`-returning implementation satisfies the
old `void` declaration. The only new obligation is the ordinary one for any
promise-returning API — a caller that *takes* the promise owns its rejection —
and the retained `emitError` handler means an ignored rejection is still both
reported and handled rather than becoming an unhandled rejection.

**Test coverage.** `packages/worker/test/extension-awaitable-patch.test.ts`
exercises the patched dependency itself rather than a mock: it imports the
installed `dist/core/extensions/loader.js` and asserts the extension API returns
the *identical* promise the runtime handed it; it calls the installed
`AgentSession.prototype._bindExtensionCore` with only the collaborators it reads
at bind time and asserts the bound actions return the original operations, that
an ignored rejection still reaches `emitError`, and that it raises no
`unhandledRejection`; and it drives a real `AgentSession` whose extension
answers the `input` hook with `handled`, proving an extension-sourced send
reported as accepted with no `agent_start` and no `agent_settled` behind it.

**Status: not filed.** A future contribution should propose this as the upstream
default rather than something each embedder patches in: knowing whether a send
was accepted is as useful to a terminal extension as to a headless host, and the
diagnostic path stays exactly where it is.

### pi-gpt-transcribe · a non-tui entry point (M8-T2)

**Against:** `github.com/youssefsiam38/pi-gpt-transcribe` @ 0.2.1 (the user's
own package, so this lands as a normal commit rather than a fork PR).

**The problem, in the package's terms.** `/transcribe` refuses outright when
`ctx.mode !== "tui"`. Two separate things are being refused at once: the
*capture-and-transcribe* pipeline, which needs nothing but a microphone and a
key, and the *component widget*, which needs a terminal. A host running Pi
through the SDK or `--mode rpc` on the user's own machine has the microphone
and the key, and gets neither — and there is no exported surface for it to
build its own front end on either, so its only option is to fork the package.

**The change, in two parts.**

**(1) Export the pieces that are not terminal-specific.** Everything below is
already written and already tested by the command path; only the barrel is new.

```diff
--- a/index.ts
+++ b/index.ts
@@
 import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
 import { registerTranscribe } from "./src/command.js";
 import { loadConfig } from "./src/config.js";
 
 export default function (pi: ExtensionAPI): void {
 	registerTranscribe(pi, loadConfig());
 }
+
+/**
+ * Programmatic surface, for a host that is not a terminal.
+ *
+ * The dictation pipeline, the transcription call and the config loader do not
+ * depend on the TUI; only the widget does. Exporting them lets a host with its
+ * own front end — a GUI, a web client, a test harness — reuse this package's
+ * configuration file, its segmentation and its retry behaviour instead of
+ * reimplementing them, and keeps one `config.json` authoritative for every
+ * front end the user runs.
+ *
+ * `WidgetState` is exported as the display contract: a host that draws its own
+ * meter shows the same four numbers the terminal widget shows.
+ */
+export { DictationPipeline } from "./src/pipeline.js";
+export type { WidgetState } from "./src/widget.js";
+export {
+	CONFIG_PATH,
+	loadConfig,
+	resolveApiKey,
+	type TranscribeConfig,
+} from "./src/config.js";
+export { transcribe, TranscriptionError, type TranscribeRequest } from "./src/openai.js";
+export { encodeWav, rmsInt16 } from "./src/wav.js";
+export { openMic } from "./src/mic.js";
```

**(2) Refuse only what actually needs a terminal.** The widget is the sole
TUI-only part, and `ctx.ui.setWidget` also accepts plain lines, which every
host supports. Guarding on `ctx.mode` at the point of the *component* rather
than at the top of `start()` lets the command work anywhere Pi has a
microphone, and degrades the meter to a status line instead of the whole
feature to an error.

```diff
--- a/src/command.ts
+++ b/src/command.ts
@@ async function start(ctx: ExtensionContext, registered: TranscribeConfig): Promise<void> {
-	if (!ctx.hasUI || ctx.mode !== "tui") {
+	// A host without dialogs cannot report failures, so it still cannot run
+	// dictation. A host *with* dialogs but no terminal can: it simply gets the
+	// string-line widget below instead of the component.
+	if (!ctx.hasUI) {
 		ctx.ui.notify(`/${COMMAND_NAME} dictates into the prompt and needs an interactive session`, "error");
 		return;
 	}
@@ 	session = current;
 
-	ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
-		current.tui = tui;
-		return new DictationWidget(tui, theme, state, config.hotkey);
-	});
+	if (ctx.mode === "tui") {
+		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
+			current.tui = tui;
+			return new DictationWidget(tui, theme, state, config.hotkey);
+		});
+	} else {
+		// No component factory outside a terminal: report the same state as
+		// lines, refreshed on the same cadence the widget repaints at.
+		current.lines = setInterval(() => ctx.ui.setWidget(WIDGET_KEY, statusLines(state, config.hotkey)), 250);
+	}
 	current.pipeline.start();
```

with the matching field on `Session`, the teardown in `finish()`, and one pure
helper:

```diff
@@ interface Session {
 	tui: Pick<TUI, "requestRender"> | undefined;
+	/** Repaint ticker for the string-line widget, outside a terminal. */
+	lines: ReturnType<typeof setInterval> | undefined;
 	inserting: boolean;
@@ async function finish(current: Session): Promise<string> {
+	if (current.lines) clearInterval(current.lines);
 	current.controller.abort();
 	current.ui.setWidget(WIDGET_KEY, undefined);
+
+/** The widget's status row, as plain lines, for hosts with no component support. */
+export function statusLines(state: WidgetState, hotkey: string | undefined): string[] {
+	const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
+	const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
+	const parts = [`● ${clock}`];
+	if (state.pending > 0) parts.push(`transcribing${state.pending > 1 ? ` ${state.pending}` : ""}…`);
+	if (state.inserted > 0) parts.push(`${state.inserted} phrase${state.inserted === 1 ? "" : "s"}`);
+	if (state.error) parts.push(state.error);
+	parts.push(hotkey ? `${hotkey} to stop` : `/${COMMAND_NAME} to stop`);
+	return [parts.join("  ")];
+}
```

`registerShortcut` is already a no-op outside a terminal, and the `input` hook
already runs in every mode, so nothing else changes.

**What this does not do, and why.** It does not open the microphone anywhere
but the Pi process. A host whose user is on another device has to capture audio
there and cannot use `openMic` at all — which is why part (1) exports
`transcribe`, `encodeWav` and the config loader separately from the pipeline:
those are the pieces a remote front end needs, and they carry no assumption
about where the audio came from.

**Not blocking.** laser does not need this patch: it reimplements dictation
against the package's `WidgetState` and `config.json` rather than driving the
package. The patch is worth filing because every other GUI host will otherwise
fork the same three files, and because `WidgetState` deserves to be a published
contract rather than a shape people copy out of `src/widget.ts`.

### pi-subagents · four patches for hosts that are not a terminal (M3-T9)

**Moot after D-140 (2026-09-08).** Laser no longer loads or bundles
pi-subagents: the agent harness is Laser's own ([`agents.md`](agents.md)), so
none of these patches is needed by this project and none will be filed from
it. They are kept below as history; each still stands on the package's own
terms should someone else want them.

**Against:** `github.com/nicobailon/pi-subagents` @ 0.65.0. Four separate PRs —
they touch different files and stand or fall independently. Each is justified
on the package's own terms; none of them mentions or needs any particular host.

---

#### 1 · Export the rest of the control channel from `./control-channel`

**The problem, in the package's terms.** `package.json` already publishes
`./control-channel` as a subpath export, and its whole point is that the
control inbox is *portable*: `watchAsyncControlInbox` explicitly watches for
interrupt, timeout, stop and steer requests, and the docstring on
`requestAsyncInterrupt` says "the runner's inbox watcher will pick it up
regardless of OS". But the barrel exports one of the four:

```ts
// src/api/control-channel.ts, in full
export {
	requestAsyncStop,
	type StopRequest,
} from "../runs/background/control-channel.ts";
```

So a supervisor, a CI wrapper, or a second Pi session can stop a detached run
but cannot steer or interrupt one, even though the runner is watching for
exactly those files. The only way to do it today is to reimplement
`steerRequestFileName` — the zero-padded timestamp, the base64url id, the
atomic temp-and-rename — from the source, which makes the file layout a de
facto public API without the version discipline of one.

```diff
--- a/src/api/control-channel.ts
+++ b/src/api/control-channel.ts
 export {
+	requestAsyncInterrupt,
 	requestAsyncStop,
+	requestAsyncSteer,
+	requestAsyncTimeout,
+	steerInboxClosedPath,
+	type InterruptRequest,
+	type SteerDeliveryMode,
+	type SteerRequest,
 	type StopRequest,
+	type TimeoutRequest,
 } from "../runs/background/control-channel.ts";
```

`steerInboxClosedPath` is in the list because `requestAsyncSteer` throws when
the inbox is closed, and a caller that cannot see the marker has no way to tell
"this run stopped accepting steers" from "the write failed" other than matching
on the message text. Nothing new is written, and nothing internal is widened:
every symbol above is already exported from the module the barrel re-exports.

---

#### 2 · Emit a `workflowGraph` snapshot for scripted workflows

**The problem, in the package's terms.** `AsyncStatus.workflowGraph` is the
package's own answer to "what shape is this run" — `formatAsyncRunProgressLabel`
reads it, the fleet view reads it, and `async-status.ts` persists it. It is
populated for declarative `chain` / `parallel` launches, where
`buildWorkflowGraphSnapshot` is handed the `ChainStep[]`. A `workflowScript`
launch persists none of it: the status file gets `workflow.trace` (an
append-and-replace log of `{operation, key, state, agent}` entries) and, when
the caller supplied one, `preflight.lanes`. So the package's own progress
label degrades to a step count for the launches most likely to have interesting
structure, and every reader — the TUI fleet view included — has to reconstruct
the shape from timestamps.

`preflight` already carries the intent (`lanes[].key`, `mode`, `decision`), and
the trace already carries what happened, keyed by the same `key`. Joining them
produces exactly the snapshot the declarative path builds, and it can be done
where the trace is already being published:

```diff
--- a/src/workflows/scripted-workflow.ts
+++ b/src/workflows/scripted-workflow.ts
@@
 	const traceChanged = () => {
-		options.onTrace?.([...trace]);
+		options.onTrace?.([...trace]);
+		// The lanes declared at launch are the intended shape; the trace says
+		// which of them have started, finished or failed. Publishing the join
+		// gives scripted runs the same `workflowGraph` a chain/parallel launch
+		// gets, so one reader serves both.
+		options.onGraph?.(scriptedWorkflowGraph(options.runId, options.preflight, trace));
 	};
```

with one pure helper beside `buildWorkflowGraphSnapshot`, so the two paths
produce the same node vocabulary:

```diff
--- a/src/runs/shared/workflow-graph.ts
+++ b/src/runs/shared/workflow-graph.ts
@@
+/**
+ * The graph of a scripted workflow, joined from its preflight lanes (the
+ * declared intent) and its trace (what actually happened). Lanes with no trace
+ * entry yet are `pending`, which is what makes this a *plan* rather than a
+ * second copy of the trace.
+ *
+ * Nodes are marked `inferred: true`: unlike a chain launch, the ordering here
+ * is observed rather than declared, and a reader that draws dependency edges
+ * must be able to tell the difference.
+ */
+export function scriptedWorkflowGraph(
+	runId: string,
+	preflight: WorkflowPreflightV1 | undefined,
+	trace: readonly WorkflowScriptTraceEntry[],
+): WorkflowGraphSnapshot {
+	const latest = new Map<string, WorkflowScriptTraceEntry>();
+	for (const entry of trace) if (entry.operation === "run" && entry.key) latest.set(entry.key, entry);
+	const keys = [...new Set([...(preflight?.lanes ?? []).map((lane) => lane.key), ...latest.keys()])];
+	const nodes: WorkflowGraphNode[] = keys.map((key, index) => {
+		const lane = preflight?.lanes.find((candidate) => candidate.key === key);
+		const entry = latest.get(key);
+		return {
+			id: key,
+			kind: "agent",
+			label: lane?.decision?.trim() || key,
+			status: scriptedNodeStatus(entry?.state),
+			flatIndex: index,
+			inferred: true,
+			...(entry?.agent ? { agent: entry.agent } : {}),
+			...(lane?.mode ? { phase: `${lane.mode} lanes` } : {}),
+			...(entry?.error ? { error: entry.error } : {}),
+		};
+	});
+	const phases = groupByPhase(nodes);
+	return { runId, mode: "workflow", phases, nodes };
+}
```

plus one optional field on the node type, which is the only schema change:

```diff
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ export interface WorkflowGraphNode {
 	itemKey?: string;
 	outputName?: string;
 	structured?: boolean;
+	/** Observed from the trace rather than declared at launch (scripted workflows). */
+	inferred?: boolean;
 	acceptanceStatus?: AcceptanceLedgerStatus;
```

**What this does not do.** It does not invent dependency edges. A scripted
workflow is JavaScript and its real dependencies are control flow; the join
above knows only that a lane exists and what state it reached. That is why
every node it produces is `inferred` and why it emits no `dependsOn`.

---

#### 3 · A live index of running foreground children

**The problem, in the package's terms.** A background run gets `status.json`,
`events.jsonl`, a control inbox, `.active-runs/` and `.terminal-runs/`. A
foreground child gets `<runId>_<agent>[_<n>]_transcript.jsonl` while it runs
and `..._meta.json` when it finishes — and nothing that says it exists. The
consequences are inside the package as much as outside it:

- `cleanupOldArtifacts` cannot distinguish a transcript that is still being
  written from one abandoned by a crashed process, so it prunes by mtime alone.
- The `/subagents status` projection has no way to report foreground children
  after a reload, which is why `canUseInMemoryStatus` gates on the *live*
  `SubagentState` and answers nothing when the session was restored.
- A crashed foreground child leaves a transcript with no metadata beside it and
  no record of what happened, forever.

The transcript path is already computed in one place, so the marker can be too:

```diff
--- a/src/shared/artifacts.ts
+++ b/src/shared/artifacts.ts
@@
+/** Directory of markers for foreground children that are still running. */
+export function getActiveChildrenDir(artifactsDir: string): string {
+	return path.join(artifactsDir, ".active-children");
+}
+
+/**
+ * Mark a foreground child live. The marker names the child, its process and
+ * its transcript, and is removed when the child settles — so a marker whose
+ * pid is gone is proof of a crash rather than an ambiguity, and retention can
+ * tell an abandoned transcript from one still being appended to.
+ */
+export function markForegroundChildActive(
+	artifactsDir: string,
+	entry: { runId: string; agent: string; index?: number; pid: number; transcriptPath: string; startedAt: number },
+): string {
+	const dir = getActiveChildrenDir(artifactsDir);
+	fs.mkdirSync(dir, { recursive: true });
+	const file = path.join(dir, `${entry.runId}_${entry.agent.replace(/[^\w.-]/g, "_")}${entry.index !== undefined ? `_${entry.index}` : ""}.json`);
+	fs.writeFileSync(file, JSON.stringify({ version: 1, ...entry }, null, 2), { encoding: "utf-8", mode: 0o600 });
+	return file;
+}
+
+export function clearForegroundChildActive(artifactsDir: string, runId: string, agent: string, index?: number): void {
+	fs.rmSync(path.join(getActiveChildrenDir(artifactsDir), `${runId}_${agent.replace(/[^\w.-]/g, "_")}${index !== undefined ? `_${index}` : ""}.json`), { force: true });
+}
+
+/** Markers whose process is gone: the children that died without writing metadata. */
+export function staleForegroundChildren(artifactsDir: string, alive: (pid: number) => boolean): string[] {
+	const dir = getActiveChildrenDir(artifactsDir);
+	let names: string[];
+	try {
+		names = fs.readdirSync(dir);
+	} catch {
+		return [];
+	}
+	return names.filter((name) => {
+		try {
+			const marker = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as { pid?: number };
+			return typeof marker.pid === "number" && !alive(marker.pid);
+		} catch {
+			return false;
+		}
+	});
+}
```

written where the transcript is opened and removed in the same `finally` that
writes `_meta.json` (`src/runs/foreground/subagent-executor.ts`). One small
file per live child, in a hidden directory beside the artifacts it already
writes, mirroring the `.active-runs/` convention the async path established.

---

#### 4 · Guard `ctx.ui.custom()` on `ctx.mode === "tui"`

**The problem, in the package's terms.** Three commands call `ctx.ui.custom()`
to open a component overlay. Outside a terminal Pi returns `undefined` from
`custom()` and no error is raised, so the command appears to run and then does
nothing at all: `/subagents fleet` opens no fleet, `/subagents-stop` opens no
picker, `/subagents admin` opens no selector. `ctx.hasUI` is `true` in RPC
mode, so a `hasUI` check does not catch it — `ctx.mode` is the discriminator.

`subagents-admin.ts` already knows this and checks `typeof ctx.ui.custom ===
"function"` before calling; the check is simply not enough, because the method
exists everywhere and returns `undefined` where it cannot draw. The other two
call sites have no check at all. Each already has a non-terminal fallback a few
lines away — a `select` picker for stop, a `select` for the admin selector, and
for the fleet the same summary text `/subagents status` prints:

```diff
--- a/src/tui/fleet.ts
+++ b/src/tui/fleet.ts
@@
+	if (ctx.mode !== "tui") {
+		// The fleet overlay is a component; outside a terminal there is nothing
+		// to draw it on and `custom()` resolves to undefined without an error,
+		// which reads as "the command did nothing".
+		ctx.ui.notify(formatFleetSummary(state), "info");
+		return;
+	}
 	try {
 		await ctx.ui.custom<undefined>(
--- a/src/slash/slash-commands.ts
+++ b/src/slash/slash-commands.ts
@@
-			const result = await ctx.ui.custom<StopSelectorResult>(
+			const result = ctx.mode === "tui"
+				? await ctx.ui.custom<StopSelectorResult>(
 				…
-			);
+				)
+				: await selectStopTargetWithDialog(ctx, candidates);
--- a/src/slash/subagents-admin.ts
+++ b/src/slash/subagents-admin.ts
@@
-	if (typeof ctx.ui.custom === "function") {
+	// `custom` exists in every mode but only draws in a terminal, where it
+	// resolves to undefined instead of failing. Gate on the mode, not the method.
+	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
```

Three guards and one summary formatter. No behaviour changes in a terminal.

## pi-mcp-adapter 2.33.0: the MCP engine, as pinned (M14-T2)

`packages/worker` depends on `pi-mcp-adapter` at exact `2.33.0`, used **only**
through its programmatic entry (`createMcpAdapter({ config })`), its standalone
`McpServerManager` for the inspector, and its OAuth flow for sign-in. Nothing
else in the repository may import it (AGENTS.md invariant 1).

Verified here, on Linux x64 with Node 24.11.1, against the pinned engine 0.85.0:

- installs clean beside the engine; its two `pkg.pr.new` tarball dependencies
  (`@modelcontextprotocol/client` and `@modelcontextprotocol/core`, an
  unreleased MCP SDK 2.0.0) receive lockfile integrity hashes, and its native
  modules (`@napi-rs/keyring` 1.3.0, `fs-native-extensions` 1.5.1) ship
  prebuilt bindings for every desktop target we ship — no toolchain, no build
  script. **These two dependencies are continuous-release tarballs, not
  registry releases**: availability and retention are outside npm's guarantees.
  A mirror or a vendored copy is the mitigation if that ever bites.
- packaging (M14-T5): the worker directly declares the six desktop
  `@napi-rs/keyring-<platform>-<arch>` bindings at **1.3.0** as optional
  dependencies, independently of the desktop's **2.0.0** pins. The binding
  packages' `os`/`cpu` fields select the build machine. The pre-pack guard
  checks both direct availability and resolution from the adapter's keyring
  in the pnpm store for the requested target; this prevents a transitive
  optional binding from silently disappearing on another architecture.
- the programmatic configuration is an isolated snapshot: no `.mcp.json`, no
  `.pi/mcp.json`, no host-config discovery, no file written (verified by a
  session with the engine loaded and by reading `config.ts`).
- stdio and Streamable HTTP both connect, direct tools register under the
  server-name prefix, image content blocks pass through verbatim, and
  `dispose()` takes the child process with it.
- the status channel (`MCP_STATUS_EVENT`) is versioned and read-only, and is
  the only thing Laser reads for per-session status.
- no patch was needed. The three upstream gaps above are worked around in
  `packages/worker/src/mcp/` without modifying the package.

## pi-web-access 0.28.0: distinguish empty results and challenges (M12-T68)

Local patch: `patches/pi-web-access@0.28.0.patch`, applied by the workspace lockfile.
DuckDuckGo's explicit no-results markup returns an empty result list, while a
challenge form raises an identifiable verification error. Unexpected HTML still
fails; no challenge bypass or alternate provider is introduced. Offline tests use
all three response shapes. No upstream issue/PR filed in this uncommitted repair.

## pi-coding-agent 0.85: per-item operations on the message queues (M13-T28)

**Not filed, and not blocking.** `AgentSession` exposes `steer(text, images?)`,
`followUp(text, images?)` and `clearQueue()`, which empties both queues and hands
their text back. There is no remove, no edit, no reorder, and
`_steeringMessages` / `_followUpMessages` are private (`getSteeringMessages()`
and `getFollowUpMessages()` are read-only views). So a UI can offer exactly one
action for the whole queue, which is why laser's composer used to make a person
press **Stop** to force one message through — and why the transcript then said
"You stopped it" about something nobody stopped.

M13-T28 ships route 1 of the two the task set out: the waiting lane is laser's
own ordered list in the worker (`@lasercode/protocol` `pending.ts`,
`packages/worker/src/pending.ts`), with per-item add/edit/remove/steer and a
delivery on `agent_settled`. A steered message leaves that list for the engine's
steering queue in the same call, so a message is never in both places and the
two can never disagree.

The API worth proposing upstream, if it is ever wanted there:

```ts
/** Remove one queued message by its position in the lane; returns what was removed. */
removeQueued(lane: "steering" | "followUp", index: number): string | undefined;
/** Replace one queued message in place. */
replaceQueued(lane: "steering" | "followUp", index: number, text: string): boolean;
```

Both are small and self-contained, and both are useful to a terminal Pi too
(`/queue` could then drop one line instead of all of them). They are *not*
required by laser: the tray above makes the engine's queues a delivery
mechanism rather than a place a person edits, which is the better boundary
anyway — the engine owns the turn, laser owns the waiting.

## pi-coding-agent 0.85: settings overrides do not survive a reload (M13-T12)

**Not filed. Worked around locally, and the workaround is tested.**

`SettingsManager.applyOverrides(overrides)` does `settings = merge(settings,
overrides)` and keeps no record of what was applied. Three methods recompute
`settings` from the global and project files and therefore discard it:

- `reload()` — `settings = merge(globalSettings, projectSettings)`;
- `setProjectTrusted()` — the same, in both directions;
- everything that calls them: `ResourceLoader.reload()` calls
  `settingsManager.reload()`, `createAgentSessionServices()` calls
  `resourceLoader.reload()`, and `AgentSession.reload()` calls both again.

So an override applied to a manager that is then handed to
`createAgentSessionServices()` is gone before the session exists — not "lost
partway through", but never in effect at all. Verified against the pinned
0.85.0 dist and pinned by `packages/worker/test/settings-overrides.test.ts`,
whose first `describe` asserts the *engine's* behaviour so an upstream fix
shows up as a failing expectation rather than as silent dead code.

Why it matters here: overrides are the only route a project's configuration
takes into the engine (nothing is written to disk), and they are how package,
extension, skill, prompt and theme discovery is switched off. A probe with
`packages` listed in the global settings file and `packages: []` applied as an
override ran a real `npm install` during service creation.

The upstream change is small and useful to any embedder: retain the applied
overrides on the manager and re-merge them at the end of `reload()` and
`setProjectTrusted()`, or — if overrides are meant to be one-shot — expose the
recompute as a hook so an embedder can re-apply. No public signature changes.

The local workaround wraps `reload` and `setProjectTrusted` on the manager
instances this project creates and re-applies its own registered overrides
after each. It touches no engine file and no settings file on disk.

## assistant-ui · React 19 resource update during render

`@assistant-ui/core` 0.3.17 (under `@assistant-ui/react` 0.15.18) raises an uncaught
React #520 — *"Cannot update a resource while rendering a different resource"* — on the
first prompt of a fresh session.

`RemoteThreadListHookInstanceManager._publishThreadRuntime` runs as the `publish` callback
of a `useResources` resource, so it executes during render. It calls `_trackRunning`, which
calls `_setRunning` synchronously, which notifies `runningSubscribers` — and one of those
subscribers is a React store update. React 19 refuses a store update raised during another
resource's render.

Reproduced on a plain chat with no agent work, a clean state directory and a clean browser
origin. The turn completes and the app keeps working; the error reaches the console.

A fix belongs upstream — notifying `runningSubscribers` outside the render phase (a
microtask or a layout effect) rather than inline in `_setRunning`. Not filed yet; tracked as
M13-T56 (first recorded as M13-T37, which the patch comment still cites).

**Carried locally as a pinned patch** (`patches/@assistant-ui__core@0.3.17.patch`, registered
in `pnpm-workspace.yaml` beside the other two). `_setRunning` keeps assigning the flag
synchronously, so `__internal_isThreadRunning` still reads back immediately; only the
subscriber notification is deferred to a microtask, coalesced per instance. A version bump of
`@assistant-ui/core` must re-apply or retire it.

**Second hunk in the same patch (M13-T53).** `RemoteThreadListThreadListRuntimeCore`'s
`initialize().then` adopts the returned `remoteId` into the thread being initialized and
deletes any listed entry that already carried that id as an "orphan" — without re-pointing
`_mainThreadId` when the orphan *is* the main thread (its own `_replaceWithThreads` does
re-point in the analogous case). A host whose thread list can already hold the session being
initialized (a session created outside the app and listed by the catalog, then reused on
the first send) then throws `useClientLookup: key … not found` from every render. The hunk
re-points `_mainThreadId` at the adopting entry and stops the orphan's runtime. Our adapter
also stops selecting from inside `initialize` and holds the controlled thread id while
initializing, so the hunk is the guard for a switch the runtime makes on its own. Worth an
upstream issue with the reproduction in `packages/ui/test/runtime/catalog-arrival.test.tsx`.

