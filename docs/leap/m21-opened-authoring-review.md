# M21-T6 M2 — opened detail / read / edit UX — independent review

Reviewed revision: `agents/finish-creation-review-fixes-78949e4c` HEAD `535a532b` vs base `de49fab3`
(delta = `79a93c48` M2 feature + `9d58b89d` lifetime hardening + `535a532b` submit-lock settlement fence;
27 files, +1998/−277). First independent review cycle. No source changes were made by this review.

## Verdict

**Fix before release — two substantive findings, the rest is debt.** The edit-owner
lifecycle (`edit-session.tsx`), the WorkDetail read token/retention work, the
exact-bytes serializer change, the decision-first Inspector and the narrow
inspector sheet are correct and well-tested. But M2 introduced one silent
draft-loss path in Design brief editing, and the Research framing editor
submits an unvalidated, uncleaned draft that the other four editors do not.
Both are small, localized fixes; they belong in the one batched fixer round.

Evidence run by this review in the target tree (no source mutation):
`vitest run` over `work-detail-edit-lifetime`, `narrow-inspector`,
`research-detail`, `design/detail`, `plan-detail`, `task-detail`,
`spec-editor`, `spec-research-model`, `markdown-authoring` — **9 files, 99 tests, all green**;
`pnpm -F @lasercode/ui typecheck` — green. Visual/touch/RTL/IME acceptance
remains person-owned under D-342; this review makes no visual claim.

## What was verified as sound

- **Immutable edit owner.** `useWorkEditSession` (edit-session.tsx:96–110)
  captures store/project/entity/selection-revision/base-revision/title/body
  once; `sameOwner` (edit-session.tsx:19–24) compares all of them; the
  invalidation effect (edit-session.tsx:47–53) and `submit`'s exact-owner
  settlement check (edit-session.tsx:146–158) mean a late reply settles only
  the owner that sent it. Both hook regressions at the bottom of
  work-detail-edit-lifetime.test.tsx (owner A's late settlement vs owner B's
  pending lock; unmounted owner vs new mount) pass.
- **No implicit rebase.** A same-current-view sequence refresh keeps the
  mounted editor and its fence (`retainsSelection`, WorkDetail.tsx:98/127);
  the newer-revision notice (edit-session.tsx:198–204) fires only on the
  moving current-view and Save keeps the original base (lifetime test asserts
  `expectedRevisionId === "r1"` after an r2 refresh). Only Design rebases, and
  only explicitly on an accepted save (DesignDetail.tsx:161).
- **Frozen pending state.** `WorkEditFields` pairs `<fieldset disabled>` with
  `MarkdownEditorActivationProvider readOnly`, so native controls and the real
  CodeMirror view freeze together (lifetime test asserts
  `contenteditable="false"` and the disabled fieldset). Duplicate Save clicks
  are admitted once (synchronous ref lock, edit-session.tsx:133–136).
- **Read tokens.** `readOwner` gates success, failure and loading alike
  (WorkDetail.tsx:93–122); out-of-order selection settlements are inert
  (test: "ignores out-of-order detail success and failure settlements").
- **Capability/archive/historical fence** is computed once in WorkDetail
  (WorkDetail.tsx:172–184) and re-checked in `submit` via `context.editable`.
- **Exact bytes.** `specBodyFrom` (spec.ts:60–71) now drops blank optional
  rows without normalizing neighbours; serializer test
  spec-research-model.test.ts:55–70 proves edge whitespace survives.
- **Research framing preserves records.** `saveFraming` (ResearchDetail.tsx:94)
  spreads `original` and maps only the stable root node by id; test asserts
  findings/sources/options/unresolved round-trip byte-equal and `q1` stable.
- **Honest states.** No fake screens/findings/evidence introduced; empty states
  offer real existing actions ("Continue this research" quote into composer,
  `FoundationStart`, `Compose screens`); Plan shows no schedule/percentage;
  Task's "no acceptance criteria" is person-judgement copy, not a fake failure.
- **Inspector and width.** Metadata moved below decision content
  (Inspector.tsx:95–223); the narrow sheet mounts the existing `Inspector`
  (Workspace.tsx:201–210); sticky compact footers for Task/Plan/Research/Spec
  editors; Design stays read-only on phone, including the resize-mid-edit
  frozen-footer case (design/detail.test.tsx:419+).
- **File sizes.** No file crosses 1k lines (largest: DesignDetail.tsx 787).
  Task/Plan/WorkDetail/SpecDocument all under 600.

## Findings

### B1 (blocker, draft loss): "Edit brief" silently discards unsaved canvas/grounding changes

`DesignDetail.tsx:403–409` (`beginBrief`):

```ts
const owner = edit.begin(body);
setDraft(structuredClone(owner.baseBody));
```

`begin` always mints a fresh owner seeded from the *loaded* body, and
`setDraft` resets the shared draft to that base. Design's own contract is one
draft body shared by canvas and brief (file header: "both produce the same
revision — one draft body"), and canvas mutations (`mutateDraft` →
`edit.ensure`) create exactly that state. Repro:

1. Open a Design with screens (or none — `HostContextPanel` also mutates the
   draft via `onChange`), capability `project/work/revise` available.
2. Move a node / commit node text / ground a host page → draft dirty, owner
   created with base = loaded body.
3. Click **Edit brief** (enabled; only `edit.pending` disables it).

The drag is gone: draft resets to the loaded body, no warning, nothing to
undo. The save that would have landed both changes now lands only the brief.
This is the same class of defect the correction checkpoint called out
("never resets a dirty canvas/brief") — here the reset comes from the
edit-enter action instead of props, but the person-visible effect is
identical silent loss.

Remedy (behavior-preserving): in `beginBrief`, keep the existing owner and
current draft when one matches — `const owner = edit.ensure(body); if (!owner)
return; if (fresh owner) setDraft(structuredClone(owner.baseBody));` — i.e.
only seed the draft when no owner existed. Add the missing regression: begin a
canvas edit, click Edit brief, assert the canvas change survives in the draft.

### B2 (substantive): Research framing editor submits an unvalidated, uncleaned draft

`ResearchDetail.tsx:94–105` (`saveFraming`): the framing state goes straight
from React state to `store.revise` — no `researchBodySchema.safeParse`, no
blank-row cleanup, no length bounds. Consequences:

- One click of "Add in-scope boundary" followed by Save submits
  `scope.in: [""]`. The schema is `line` = `min(1).max(500)`
  (project-work-bodies.ts:37, :261), so the host refuses with a raw shape
  message. The draft is kept (good), but the person gets a wire error where
  every other editor gives a prepared sentence.
- This is the same `MarkdownListField` control creation uses, and creation
  *does* clean it: `create-draft.ts:141–142,169` drops blank rows via
  `values(draft.inScope)`. M1 and M2 disagree about what the same control
  persists.
- No `maxLength` is passed to any M2 field although `MarkdownSourceEditor`
  already implements protocol-bounded transaction filtering
  (MarkdownSourceEditor.tsx:66–75) and M1's CreateDialog uses it
  (CreateDialog.tsx:249). An over-length question (`RESEARCH_QUESTION_MAX`)
  or scope row is likewise only caught by the host.

Remedy: give framing the same treatment the other editors have — a small
`researchFramingFrom`-style cleanup (reuse `create-draft`'s `present` rule)
plus `researchBodySchema.safeParse` before `edit.submit`, and pass the
protocol maxima into the fields. Test repro: open Edit framing, add a blank
in-scope row, Save → today a host shape refusal; expected: row dropped
silently like creation, or a field-level message.

### B3 (medium): schema-limit errors are one generic banner, and no field is bounded

`TaskBodyEditor.tsx:39–45` and `PlanDetail.tsx:265–272` run
`projectWorkBodySchema.safeParse` but collapse any failure into "Some task/plan
fields are incomplete. Finish or remove the incomplete row before saving." No
field is named. Inputs for `line`-bounded values (risk summary 500, boundary
scope, dependency reason, verification commands) carry no `maxLength`, so a
600-char risk summary is only discovered at save. SpecDocument has no client
parse at all (over-limit document → host refusal). The correction checkpoint
says "Schema limits produce visible field errors rather than truncation or
draft cleanup" — a visible but unlocatable banner meets the letter, not the
intent. Remedy: pass the protocol maxima (the mechanism already exists) and,
where cheap, surface the first zod path as the field's message.

### Debt (non-blocking, ranked)

1. **Dead, drifting read views.** `PlanBodyView`, `TaskBodyView`,
   `DesignBodyView` in bodies/index.tsx are unreachable from the app: WorkDetail
   routes plan/task/design to their detail components with a context, and
   `WorkBody` is only called with one (WorkDetail.tsx:329). They already drift —
   `TaskBodyView` renders acceptance text literally
   (bodies/index.tsx:502) while the live TaskDetail renders it as Markdown
   Prose. Delete them and reduce `WorkBody` to the spec/research pair it still
   serves, or fold the views into the detail components.
2. **Triplicated selection-match boolean.** The same five-term
   `retainsSelection` expression appears at WorkDetail.tsx:98 (read), :127
   (effect) and again as `detailMatchesSelection` (:158, render). Extract one
   `retainsSelection(detail, store, entityId, revisionId, projectId)` helper;
   three copies of an identity invariant is a drift trap.
3. **Spec's sticky footer is bespoke.** SpecDocument.tsx:250–257 duplicates the
   `WorkEditFooter` markup by hand while Task/Plan/Research use the shared
   component. Parameterize `WorkEditFooter` with children or move Spec onto it.
4. **Inconsistent blocked-settlement handling.** Task/Plan show an inline error
   plus "Your draft is still here."; Spec toasts; Design silently returns on
   `settled.kind !== "settled"` (DesignDetail.tsx:160) — a revoked-capability
   click on Save does nothing visible. Say the readOnlyReason at least.
5. **Research sibling writes stay live during a framing save.** While the
   framing banner is open (even pending), `ResolveForm`/`AddQuestion` below
   still write with the loaded body against `detail.revision.revisionId`
   (ResearchDetail.tsx:462, :500). The host refuses the second fence as a
   conflict and the toast is visible, so nothing is lost, but the pending
   framing owner does not freeze the sibling writes the way it freezes its own
   fields. Consider gating them on `!edit.pending`.
6. **Test timing is inconsistent.** `editCode` polls 25 ms × 40 in
   work-detail-edit-lifetime, research-detail, task-detail and spec-editor, but
   plan-detail.test.tsx:71, design/detail.test.tsx:120 and task-detail's
   `openMenu` sleep a fixed 100 ms. Fixed sleeps are the flake class the worker
   already had to fix once (the honest 100 ms → 25 ms×40 correction). Prefer the
   bounded-condition form everywhere.
7. **JSON-order sensitivity in `changed`.** `without(body, "planKey")` then
   re-adding moves the key to the end, so a remove/re-add of an optional key
   flips `changed` true with no semantic difference (TaskBodyEditor.tsx:41).
   Only affects save-button enabling; harmless but worth a normalizing compare
   if it ever bothers the tests.

## Coverage limitations

- No browser interaction was performed (D-342); layout, RTL, IME, touch,
  reduced-motion and theme claims are code-read + unit proxies only. The
  person's `pnpm -r build && pnpm sandbox` pass is still required.
- The full M2 suite was not re-run end-to-end here (the parent is running
  independently); this review re-ran the 9 most affected files (99 tests) plus
  typecheck. `workspace.test.tsx` and the creation-dialog suite were not
  re-run; they are untouched by the delta.
- The fixer round should re-run at minimum the lifetime, design/detail,
  research-detail, plan-detail and task-detail files after B1/B2.
