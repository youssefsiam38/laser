# M21-T22 — the leap's threat model

The security, privacy, relay and resource audit of everything M21 added, written
before the hardening code so that the hardening has a target. It is meant to be
falsifiable: every control names the file and line that implements it, every gap
names the test that will prove it, and a control that does not exist is written
down as a gap rather than as prose.

**State.** §0–§9 are the audit, written before any hardening code. §10 is the
gap register, and each row now carries what was done about it: seven gaps were
closed in this task, one was proved not to be a gap, and one is reported to its
owner because the fix is outside this task's write set. Where a gap is closed,
the control's file and line are updated in place.

Scope: the project lifecycle surfaces only — the host's `project/work/*`,
`project/task/*` and `design/*` methods, the worker bridge and its tools, the
Research adapters, the Design Index and Sketch, interop (import/export/publish),
captures and blobs, verification commands, the leap's share of the quota system,
and what a phone reaches through the relay. Pre-leap surfaces (sessions,
settings, MCP, source control) are covered by [`../security.md`](../security.md)
and are read here only where the leap depends on them.

Binding documents: [`../project-lifecycle-leap.md`](../project-lifecycle-leap.md)
"Security, privacy and resource rules", [`../design-phase.md`](../design-phase.md)
(D-353, D-354), [`../research-phase.md`](../research-phase.md),
[`../agent-tool-contract.md`](../agent-tool-contract.md),
[`../agents.md`](../agents.md) §6, `AGENTS.md` invariants 1, 6, 7 and 9,
decisions D-329–D-333, D-345–D-355, D-361, D-363–D-367.

---

## 0. Assets, adversaries and what is out of scope

| Asset | Why it matters |
| --- | --- |
| Canonical project work | Specs, Research, Designs, Plans, Tasks: the durable record decisions rest on |
| Approvals and gate decisions | Authority over what "approved" and "done" mean in this project |
| Evidence and captures | Proof that survives checkpoint pruning; forging it forges delivery |
| The project's own files | Import roots, export roots, `.laser/design/*`, the checkout git reads |
| This machine's credentials | Provider credentials and pairing keys; never part of project work |
| Machine time and space | Quotas, worker processes, verification commands, adapter egress |

| Adversary | Assumed capability | Covered here |
| --- | --- | --- |
| A hostile model | Writes any tool argument, any body, any mention ref | §2, §3, §5, §6 |
| A hostile source | Controls a fetched page, a repository, a package manifest, an imported file | §4, §6, §9 |
| A paired phone | Authenticated, holds the scopes the environment granted | §1, §8 |
| The relay operator | Reads and rewrites every byte | §8 |
| A hostile project tree | Symlinks, traversal names, huge and corrupt files | §6, §7 |
| Malware on the desktop | Root on this machine | **Out of scope** — it already is the agent (`../security.md` §2) |

Not in scope for this task: Pi extensions (unsandboxed upstream), the pairing
protocol itself (M6, covered in `../security.md`), and person-owned acceptance
in a browser (D-342).

---

## 1. The host boundary and method policy

**Threat.** A remote or browser-origin caller exercises project authority it was
never granted, or a caller asserts its own identity in a request body.

**Controls.**

- Authorization runs on the method name alone, before params are parsed:
  `packages/host/src/router.ts:355-372`. An unknown method never reaches a
  parser (`packages/protocol/src/method-policy.ts:480-486`).
- The policy table is compiler-complete —
  `satisfies Record<ClientMethod, MethodPolicy>` at
  `packages/protocol/src/method-policy.ts:445` — so a new leap method cannot
  ship without a scope and a reach. Every leap method has its row:
  reads at `method-policy.ts:380-388`, mutations at `:389-407`, interop at
  `:408-421`, design at `:422-441`.
- Scope narrowing is intersection only: `packages/host/src/access.ts:188-232`;
  a device grant and an environment policy can only remove
  (`packages/protocol/src/environment-policy.ts:252`).
- A direct socket must be loopback, checked before the origin check:
  `packages/host/src/server.ts:964`; frames above `FRAME_MAX_BYTES` are refused
  by `ws` before any JSON exists: `server.ts:957`.
- The actor is what the boundary proved, never a body: `ProjectWorkCaller.actor`
  (`packages/host/src/project-work/methods.ts:141-142`), and the actor **kind**
  is decided in exactly one place — client ⇒ `person`, worker bridge ⇒ `agent`
  (`methods.ts:1206-1221`). That is what makes "only a person approves" (D-332)
  enforceable.
- A worker's writes are fenced to the project the host spawned it for; a read of
  another project is allowed, a write is refused with the owning project named:
  `methods.ts:860-885`.
- A declined folder refuses every mutation while reads stay open:
  `methods.ts:1181-1200`.

**Gaps.**

| # | Gap | Proof |
| --- | --- | --- |
| G1 | `PROJECT_WORK_METHOD_LIMITS` and `PROJECT_WORK_BODY_MAX_BYTES` (`packages/protocol/src/project-work-methods.ts:118,1250-1274`) document a per-method and per-body ceiling the host "refuses above" — **nothing read either constant**. The only real ceiling was the 64 MB frame, so one `project/work/create` stored a body sixteen times the documented maximum and spent a sixteenth of the project's 512 MB budget in one call. **Closed:** `refuseOversized` in `packages/host/src/project-work/methods.ts` measures the body, then the request, against both tables (interop included) before anything is looked up or charged. | red: a 5.6 MB body was accepted and stored (`bodyBytes: 5648232`) |
| G2 | No test asserted the *documented* remote subset: the compiler proves a row exists, nothing proved the row is the right one. A future leap method typed `scope: "read"` for a mutation would compile and ship. **Closed:** `packages/protocol/test/leap-policy.test.ts` holds the matrix as data and checks it against the table. | proved to bite: retyping `project/work/approve` as `read` fails two of its cases |

**Tests that prove them.** `packages/host/test/project-work/hostile-payloads.test.ts`
(over-ceiling body refused as a typed refusal, nothing stored) and
`packages/protocol/test/leap-policy.test.ts` (every leap method's scope/reach is
the documented one, and the phone matrix in §8 is derived from the table rather
than written twice).

---

## 2. The tools a model may call

**Threat.** A model writes a body that cannot be represented, approves its own
work, reports a verification result it did not obtain, or writes into another
project.

**Controls.**

- Four project tools plus the verify tool, each intent-named and closed:
  `inspect_project_work`, `write_project_artifact`, `request_project_review`,
  `report_project_task` (`packages/worker/src/project-work/tools.ts:93,159,201,254`)
  and `verify_project_task`
  (`packages/worker/src/project-work/verification/tools.ts:33`).
- Every tool call crosses the bridge, where the host re-derives the project from
  the worker's own directory and ignores anything the call says about it
  (`packages/host/src/project-work/methods.ts:231-268`).
- `request_project_review` cannot approve: the actor kind is `agent` and the
  store refuses an agent approval (D-332, `methods.ts:1206-1221`).
- A verification report supplies exit codes and bounded output and nothing else;
  the criteria, their meaning and the Task transition are the host's
  (`methods.ts:957-1105`).
- Native acceptance is person-only and checked in full — current revision, the
  digest the store holds, a checkpoint ref that really resolves to the named
  commit, capture stored before the acceptance exists
  (`packages/host/src/project-work/gate.ts:388-500`).

**Gap.** None found in authority. One privacy note, not a gap: a tool answer
never carries the checkout path — it is dropped at `methods.ts:596-597` and kept
in the store.

---

## 3. Hostile payloads over the wire

**Threat.** A body or tool argument that is valid JSON but hostile: traversal in
a path field, prototype-pollution keys, NUL and invalid UTF-8, mention refs
pointing at other projects, script-bearing Markdown, deep nesting.

**Controls.**

- Closed schemas everywhere: every project-work param object is `.strict()`
  with per-field ceilings (`packages/protocol/src/project-work-methods.ts:996-1214`),
  and bodies are closed unions with per-array caps
  (`project-work-bodies.ts:98-295,354-440`).
- Export/import/publish paths are contained (§6).
- Markdown is rendered without `rehype-raw`
  (`packages/ui/src/components/assistant-ui/elements/markdown-text.tsx:12-13`,
  `packages/ui/src/components/preview/MarkdownPreview.tsx:20-21`), so agent- and
  source-authored text cannot become markup (invariant 9).
- A mention ref is typed and resolved through the host, which applies the same
  read authorization as a direct read (`packages/host/src/router.ts:1561`).

**Gaps.**

| # | Gap | Proof |
| --- | --- | --- |
| G3 | `z.record` fields (`project-work-bodies.ts:414,1136,1139,1224`) have no entry-count cap and accept arbitrary key names, including `__proto__`. **Not a gap, now proved:** zod drops a `__proto__` key rather than assigning it (zod 3.25.76), so nothing reaches a prototype; the uncapped entry count is what made an unbounded body possible, and the G1 ceiling bounds it. | the prototype case in `hostile-payloads.test.ts`, plus a direct probe of `z.record` |
| G4 | No end-to-end hostile-payload suite existed for the leap: traversal in `export/apply` and `import/preview` paths, NUL/lone-surrogate text, oversized and deeply nested bodies, script-bearing Markdown and source text. Individual controls exist; nothing proved them together at the method door. **Closed:** `packages/host/test/project-work/hostile-payloads.test.ts` and `packages/ui/test/project-work/untrusted-text.test.tsx`. | red: the oversized body above; the others pass and now stay proved |

**Test.** `packages/host/test/project-work/hostile-payloads.test.ts` — one file
per §3 row, each asserting a refusal or a stored-as-text outcome plus "nothing
was written", and `packages/ui/test/project-work/untrusted-text.test.tsx` for
the render side.

---

## 4. Research adapters: egress, budgets, cache, licence and trust

**Threat.** The model turns Research into a request forge: reaching this
machine's private network, following a redirect into it, pulling an unbounded
body, or laundering an unlicensed source into a finding.

**Controls.**

- One bounded fetch for every network adapter
  (`packages/worker/src/research/adapters/fetch.ts:67-117`): http(s) only,
  no credentials in the URL, a literal private/loopback/link-local host refused
  (`fetch.ts:33-64`), a 2 MB ceiling read from the stream
  (`fetch.ts:24,119-150`), a 20 s timeout, and a declared `content-length` far
  over the ceiling refused before reading.
- Adapters are capability-gated: a disabled adapter's tool is absent
  (`packages/protocol/src/research.ts:373-379`,
  `packages/worker/src/research/tools.ts:164-216`).
- Visible budgets and a digest cache bound repeat work
  (`packages/worker/src/research/budget.ts:71`,
  `packages/worker/src/research/cache.ts:66-112`).
- Confidence is assigned by rule, and an official/primary claim that is not one
  is refused (`packages/protocol/src/research.ts:579-631`); reuse under an
  unknown or proprietary licence carries its refusal sentence (`research.ts:816`).
- `project` adapter reads are fenced by project trust
  (`packages/protocol/src/research.ts:120`).

**Gaps.**

| # | Gap | Proof |
| --- | --- | --- |
| G5 | `fetch.ts` passed `redirect: "follow"`. The private-address floor was applied to the **first** URL only, so a public page answering `302 Location: http://127.0.0.1:41441/…` (or `169.254.169.254`) was fetched and its body returned to the model. **Closed:** redirects are followed by the module itself, one hop at a time, each hop through `checkFetchTarget`, bounded by `RESEARCH_FETCH_MAX_REDIRECTS`. | red: the redirect cases answered instead of refusing |
| G6 | The repository adapter built a git remote from any host and never applied the floor: `read_source` on `https://127.0.0.1/x` made git connect to loopback. Egress through git was not covered by the fetch guard at all. **Closed:** `resolveRepositoryInput` goes through the shared `isPrivateResearchHost`. | red: `resolveRepositoryInput("https://127.0.0.1/acme/widgets")` returned a remote |

**Test.** `packages/worker/test/research/egress.test.ts` — an inert fetch double
that answers a redirect chain, and `resolveRepositoryInput` over private hosts.
No external network is contacted.

---

## 5. Design: parse-only index, host grounding, Sketch sandbox

**Threat.** Design discovery executes project code; a model-written Sketch
escapes its frame or phones home; grounding runs a route.

**Controls.**

- L0 parsing spawns nothing and opens no socket
  (`packages/worker/src/design/index/facts.ts:17`), proved by
  `packages/worker/test/design/parse-only.test.ts`.
- Host grounding is a static outline over templates and routes; there is no
  runner (D-353), `packages/worker/src/design/host/*`.
- The design methods are routed to the worker that owns the project, with the
  directory the **host** resolved; a caller's `cwd` is discarded
  (`packages/host/src/router.ts:434-456`).
- A Sketch renders only in `<iframe srcdoc sandbox="allow-scripts">` — never
  `allow-same-origin` — with a CSP meta injected first in `<head>`, a size
  ceiling, and a sanitised title (`packages/ui/src/design/sketch.ts:26-95`,
  `packages/ui/src/components/design/SketchFrame.tsx:76`).
- A Sketch can never be approved or handed off; it must be grounded first
  (`sketch.ts:107`).

**Gap.**

| # | Gap | Proof |
| --- | --- | --- |
| G7 | `sketchSrcDoc` found the insertion point with `/<head[^>]*>/i`. A Sketch containing `<!-- <head> -->` before its real head had the CSP meta inserted **inside that comment**, so the document loaded with no policy: `default-src 'none'` was gone and the frame could open connections. The sandbox still denied same-origin access, so this was egress and beaconing from model-written markup, not access to Laser's state — but the documented control was defeated by a payload a model can write. **Closed:** the insertion point is found by a comment-aware scan (`packages/ui/src/design/sketch.ts`), and a document with no live `<head>`/`<html>` gets the policy in front of everything. | red: the injected meta landed between `<!--` and `-->` |

**Test.** `packages/ui/test/design/model.test.ts`, "puts the policy in live
markup, whatever a hostile sketch writes before its head": the commented head,
the textual `&lt;head&gt;`, the commented root and the unterminated comment.

---

## 6. Interop: import, export, publication

**Threat.** An export escapes the project through a symlinked ancestor or a
traversal name; an import reads outside the project; a publication rewrites
history or commits something the preview never showed.

**Controls.**

- The export root is resolved through `realpath` once, each component is
  re-resolved, containment is checked lexically on both the written and the real
  path, and files are opened `O_NOFOLLOW`
  (`packages/host/src/project-work/export/paths.ts:15-33,98-175,301-330`).
- The import root is normalised and asserted inside the project before an
  adapter runs (`packages/host/src/project-work/import/index.ts:209-212`); the
  adapter reads once and watches nothing (`import/index.ts:18-25`).
- Apply is fenced by the digest of the preview it was decided from, and every
  collision is a person's explicit choice (`import/index.ts:84-96`).
- An export's manifest carries stable ids, revision digests and relations, and
  the apply answer carries the manifest digest (`export/manifest.ts`).
- Publication records `published_as` only after the exact commit is known
  (`packages/host/src/project-work/publish/git.ts`).
- Existing coverage: `packages/host/test/project-work/interop-paths.test.ts`,
  `interop.test.ts`, `interop-git.test.ts`.

**Gap.** No *method-door* test: the path tests call the path helpers. A
traversal or absolute path arriving as `project/work/export/apply { root }` is
believed to be refused, but that belief is untested at the wire. Covered by the
G4 suite.

---

## 7. Captures, blobs, quotas and resource bounds

**Threat.** Unbounded reads and writes: a page that returns everything, a body
read whole, a corrupt blob served as plausible bytes, a project that fills the
disk, a helper process nobody owns.

**Controls.**

- Every read is paged or ranged and clamped in the store: list
  (`store.ts:3804`), search (`store.ts:4269`), attention (`store.ts:3938`),
  edges/links/executions/comments/approvals/evidence/decisions/revisions
  (`store.ts:4057,4084,4113,4181,4191,4201,4225,4246`), body ranges
  (`store.ts:4035-4036`), blob pages (`store.ts:3770`), capture history
  (`store.ts:2631`).
- A blob page that no longer matches its digest is a refusal, not a page, and a
  released derived blob is labelled rather than empty
  (`packages/host/src/project-work/methods.ts:783-812`).
- The durable budget counts every canonical row, not just bodies, and a full
  budget refuses the write with the recovery action (D-365,
  `packages/host/src/project-work/accounting.ts:1-105`,
  `store.ts:877-910`); canonical work is never evicted automatically.
- Verification commands are bounded, stoppable and owned: exact byte count and
  digest with a kept tail, `CI=1`, no interpolation beyond the declared line,
  the process registered as a helper, and no record invented while the tree is
  alive (`packages/worker/src/project-work/verification/commands.ts:1-33,435-460`,
  registration at `:449`).
- Index builds are bounded, stoppable fleet Commands
  (`packages/worker/src/design/index/command.ts`).

**Gaps.**

| # | Gap | Proof |
| --- | --- | --- |
| G8 | Nothing asserted the caps as a set. Each is written at its call site, and a new read added without one would pass every existing test. **Closed:** `packages/host/test/project-work/resource-guards.test.ts`. | the suite itself |
| G10 | `runGit` (`packages/protocol/src/git-run.ts:8,57`) starts git with `execFile` and registers **nothing** with the worker's process inventory, so every git child a Research repository read, a publication or a capture starts is an `unknown_descendant` in the fleet's process view. Every helper this task's own area starts *is* registered (`verification/commands.ts:449`, `agents/worktrees.ts:323`, `project-env.ts:392`). **Not fixed here:** `git-run.ts` is shared with the source-control leap (M20) and outside this task's write set. Low severity — the host still measures the process and attributes it by ancestry — but it is the one "owned helper" hole the audit found. | `grep -rn noteWorkerProcess packages/worker/src` |

**Test.** `packages/host/test/project-work/resource-guards.test.ts`: every
project-work read answers within its documented cap when asked for more, and the
body ceiling refuses before anything is charged.
`packages/worker/test/project-work/owned-helpers.test.ts`: the one thing a
verification run executes is registered as this worker's helper, runs the
declared line in the declared checkout with `CI=1`, and registers nothing when
nothing was started.

---

## 8. Relay and phone: the capability matrix

**Threat.** The relay learns project content; a phone exercises authority a
person did not intend; a UI surface offers an action the connection cannot make.

**Controls.**

- The relay parses nothing but the channel id and forwards padded ciphertext
  (`packages/relay/src/server.ts:2-18`; invariant 7).
- A device hears only the notifications its scopes cover
  (`packages/host/src/server.ts:1041`, `server.ts:1806`).
- The UI derives every affordance from the descriptor and the policy table, so
  there is no second copy of the rules
  (`packages/ui/src/runtime/environment-capabilities.ts:68-97`); an action a
  connection cannot make is hidden or explained, never a button that fails.
- Phone output is escaped and never raw HTML (invariant 9, §3).

**The matrix.** Derived from `METHOD_POLICY`; this table is the documented
expectation, and two tests hold the product to it:
`packages/protocol/test/leap-policy.test.ts` (every row's scope and reach, and
no leap method missing from the matrix) and
`packages/host/test/project-work/capability-matrix.test.ts` (a real paired
device: writes and approvals by default, and under an environment that
withholds `project_write`, every mutation refused on the method name with the
store untouched while every read still answers).

| Leap action | Method | Scope | Reach | Phone by default | Phone when the environment withholds the scope |
| --- | --- | --- | --- | --- | --- |
| Read the backlog, an item, search, an attachment page | `project/work/list`, `/get`, `/search`, `/blob/read` | `read` | any | yes | hidden/explained |
| Create, revise, archive, delete | `project/work/create`, `/revise`, `/archive`, `/delete` | `project_write` | any | yes | read-only workspace |
| Comment, resolve a comment, review | `project/work/comment`, `/resolve-comment`, `/review` | `project_write` | any | yes | comments hidden |
| Approve or decline a gate | `project/work/approve` | `project_write` | any | yes (person-only by actor kind) | Approval Card explains |
| Link, unlink, task action, link execution | `project/work/link`, `/unlink`, `project/task/action`, `/link-execution` | `project_write` | any | yes | explained |
| Import, export, publish (preview and apply) | `project/work/{import,export,publish}/{preview,apply}` | `project_write` | any | yes | explained |
| Read the Design Index | `design/index/get` | `read` | any | yes | explained |
| Build/stop/review the index, ground a page or sketch | `design/index/build`, `/stop`, `/review`, `design/host/ground`, `design/sketch/ground` | `project_write` | any | yes | explained |
| Start/stop a verification run | `pi/project/verify/start`, `/stop` | `execution` | any | only with `execution` | explained |
| Read a verification run | `pi/project/verify/state` | `read` | any | yes | explained |
| Accept a checkpoint preview as Native evidence | `project/work/link` with `verifiedAt.acceptance` | `project_write` | any | yes — **person actor only** | explained |

**Two properties this matrix asserts, and one open question for the ledger.**

1. No leap method is `reach: "native"`. That is deliberate: the leap's product
   contract says a phone reviews and approves the same work a desktop does
   ("Phone and relay clients receive bounded frames…; environment policy may
   make preview read-only while retaining comments and approval").
2. Person-only is enforced by **actor kind**, not by device class: an agent can
   never approve or accept, from any connection
   (`methods.ts:1206-1221`, `gate.ts:398-404`).
3. **Open, for the parent to number as a decision.** The contract is silent on
   whether Native acceptance — the one act that converts a person's eyes into
   durable evidence — should additionally require a local connection. Two
   options: (a) keep it `any`, as today, since pairing already grants prompts
   and approvals and a phone preview is a real preview; (b) make the
   `acceptance` variant local-only, since the evidence claims someone looked at
   a rendered build. This document recommends **(a)**, unchanged, because it
   keeps Laser the single authority and adds no rule the UI would have to
   explain twice; the acceptance already binds the exact capture, revision
   digest and checkpoint, which is what makes it evidence. Recorded here as a
   proposal; the ledger owner assigns the `D-<n>`.

---

## 9. Credentials and source markup

**Threat.** A credential reaches an artefact a person shares; project source or
agent text reaches a renderer as markup.

**Controls.**

- The audit rows for approve/delete/archive/import/export/publish are assembled
  field by field from identity and digests — never a title, body or note
  (`packages/host/src/project-work/methods.ts:1226-1261`).
- The host's log store redacts credential-shaped keys
  (`packages/protocol/src/log-redaction.ts`) and a stored provider body is
  scanned key-by-key as it arrives (`packages/protocol/src/credential-scan.ts`).
- Git-actions output is redacted before it can reach a result or a log
  (`packages/worker/src/git-actions/runner.ts:46-80`).
- Research refuses credentials in a URL (`checkFetchTarget` in
  `packages/worker/src/research/adapters/fetch.ts`) and never adds an
  `Authorization` header (`fetch.ts`, module comment).
- Project configuration lives in `<project>/.laser`; `auth.json` and provider
  settings are not project work and no leap writer reads them.
- Source markup: no `rehype-raw` anywhere (§3), Sketch only inside its frame
  (§5), verification output kept as text with a bounded tail (§7).

**Gap.**

| # | Gap | Proof |
| --- | --- | --- |
| G9 | Nothing proved the negative: no test ran the leap's artefact producers with a known secret present in the environment and in a `.laser` credential file. **Closed, and nothing was found leaking:** the guard passes on the first run, which is the result worth recording — the producers were already clean, and they now stay clean. | the guard itself |

**Test.** `packages/host/test/project-work/leak-guard.test.ts`: a provider-shaped
sentinel in `process.env`, a second in `<project>/.laser/auth.json`, and a third
in the person's own body text. Every exported file and manifest, every audit
row, every notification and the read answers a phone would get are scanned. The
person's words appear in the export (that is what an export is) and in nothing
else.

---

## 10. Gap register

| # | Area | Gap | What was done | Test | State |
| --- | --- | --- | --- | --- | --- |
| G1 | host | documented body/method byte ceilings unenforced | `refuseOversized` measures body then request against both limit tables, before any lookup or charge | `hostile-payloads.test.ts`, `resource-guards.test.ts` | closed |
| G2 | protocol | no guard on the leap's scope/reach assignment or the phone matrix | the matrix as data, checked against `METHOD_POLICY` | `leap-policy.test.ts` | closed |
| G3 | protocol | `z.record` bodies uncapped, prototype-shaped keys untested | proved: the key is dropped, never assigned; size is bounded by G1 | `hostile-payloads.test.ts` | not a gap |
| G4 | host, ui | no hostile-payload suite at the method door | traversal, NUL and lone surrogates, nesting, oversize, markup | `hostile-payloads.test.ts`, `untrusted-text.test.tsx` | closed |
| G5 | worker | research fetch followed redirects without re-checking the floor | manual redirects, the floor on every hop, a bounded chain | `research/egress.test.ts` | closed |
| G6 | worker | repository adapter reached any host, floor never applied | the same floor when a repository is resolved | `research/egress.test.ts` | closed |
| G7 | ui | Sketch CSP could be injected into a comment | comment-aware insertion point, policy always live markup | `design/model.test.ts` | closed |
| G8 | host | read caps asserted nowhere as a set | one guard over every project-work read and the write ceiling | `resource-guards.test.ts` | closed |
| G9 | host | no leak guard over produced artefacts | sentinel scan across exports, audit rows, notifications, reads | `leak-guard.test.ts` | closed, nothing found |
| G10 | protocol/worker | git children are started unregistered | reported to the source-control owner; `git-run.ts` is outside this write set | — | open, reported |
| — | host | phone capability matrix unproved end to end | a paired device under a narrowed environment: reads answered, every mutation refused on the method name with nothing written | `capability-matrix.test.ts` | closed |

Out of this task's hands, recorded for the owners:

- Project identity and relocation (`store.ts` identity section, `projects.ts`)
  belong to M21-T20; nothing here touches them.
- G10's fix belongs with `packages/protocol/src/git-run.ts`, shared with the
  source-control leap.
- Person-owned acceptance in a browser (D-342) is unchanged by this task: the
  Sketch fix is proved by unit tests over the injected document, not by opening
  a frame.

## 11. What was run

Frozen install, recursive build, then the focused suites for everything this
task touched, each with `env -i PATH HOME`:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm -r build` | pass |
| `vitest run --root packages/protocol` | 763 pass, type errors none |
| `vitest run test/project-work --root packages/host` | 400 pass (26 files) |
| `vitest run test/research test/project-work test/design --root packages/worker` | 473 pass (31 files) |
| `vitest run test/design test/project-work test/elements --root packages/ui` | 432 pass (37+ files) |
| `pnpm -F @lasercode/{protocol,worker,host,ui} typecheck` | pass |
| `pnpm identity:check` | pass |

Red evidence, taken before each fix:

| Gap | Red |
| --- | --- |
| G1 | `project/work/create` stored a 5.6 MB design body (`bodyBytes: 5648232`) with no refusal |
| G5 | the redirect cases in `research/egress.test.ts` answered instead of refusing; 7 of 8 red |
| G6 | `resolveRepositoryInput("https://127.0.0.1/acme/widgets")` returned a git remote |
| G7 | the CSP meta was inserted between `<!--` and `-->` for a sketch whose comment mentions `<head>` |
| G2 | proved to bite by retyping `project/work/approve` as `read`: two cases fail |

No browser was opened, no external network was contacted, and no limit was
raised: every ceiling in this task is the one the protocol already documented.
`pnpm verify` is the integrator's, not this task's.
