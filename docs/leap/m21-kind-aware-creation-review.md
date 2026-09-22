# Independent review — M21-T6 Milestone 1, kind-aware creation + highlighted Markdown authoring

Status: **changes requested — two keyboard/accessibility blockers, one provenance regression, one error-copy defect; structure otherwise sound**.

## Scope and revisions

- Target: branch `agents/correct-typed-authoring-behavior-310e7841`, HEAD `61dee709` ("fix(ui): correct bounded Markdown authoring") vs `main` `8313acbc`.
- Original source `016557c9` preserved via merge `b0c23965`; the correction commit is the delta `b0c23965..61dee709`. `STATUS.md`/`STATUS_DETAILED.md` deltas are ledger-only and ignored.
- Contracts read in the target tree: `docs/leap/m21-kind-aware-creation-plan.md` (approved plan + correction evidence), the `project-work-bodies.ts` closed schemas, `store.ts`, `create-work.tsx`, `FoundationWizard.tsx`, and the full new/changed UI surface: `CreateDialog.tsx`, `CreateKindFields.tsx`, `MarkdownAuthoringField.tsx`, `MarkdownSourceEditor.tsx`, `create-draft.ts`, and the four touched test files.
- M2 opened views are out of scope and their absence is not flagged.

## Validation performed (target tree, read-only)

- `pnpm -F @lasercode/ui exec vitest run test/project-work test/design-system` — 32 files, **272 tests pass**.
- `pnpm -F @lasercode/ui exec vitest run test/design` — 10 files, **123 tests pass** (395 total, green).
- `pnpm -F @lasercode/ui typecheck` — pass.
- Cross-checks by reading: every CSS variable the CodeMirror theme uses exists in `globals.css`; the serialization limits (500-char rows, 2000-char paragraphs, `RESEARCH_QUESTION_MAX` 500, `PROJECT_WORK_MARKDOWN_MAX` 200 000, 200-char phase names, 1000-char commands, `opaqueId` ≤ 64 chars which fits `prefix-` + UUID) all match the protocol schemas; `firstBody` is retained and the slash-command suite is green; the lockfile adds only the approved exact-pinned packages, no patch-section changes; `packages/ui/src/components/design/*` is untouched except the sanctioned `FoundationWizard.tsx` caller migration; `workspace.test.tsx` unmodified.

The real-editor claims hold up: labels/description on `.cm-content`, Tab escape, IME-gated shortcut, transaction-bounded input, one editor per kind at the 256-row schema limit with selection+undo surviving hide/restore, and pending read-only fencing are all covered by `test/project-work/markdown-authoring.test.tsx` (real CodeMirror in happy-dom) and `test/project-work/dialogs.test.tsx` (field logic with the editor mocked and named as such).

## Blockers

### B1 — Primary validation error does not move focus (silent no-op)

`CreateDialog.tsx:129-134`:

```ts
const region = document.getElementById(target);
const control = checked.primary ? region?.querySelector<HTMLElement>("[aria-label]") : region;
control?.focus();
```

For a primary-field error, the first element with `[aria-label]` inside `#${kind}-create-primary` is **the non-focusable Write/Preview tablist div** (`MarkdownAuthoringField.tsx:115`, `<div role="tablist" aria-label={…}>`), which precedes the editor content in DOM order. A `.focus()` on a div without a tabindex does nothing, so focus stays on the Create button. This contradicts the approved plan's own acceptance item ("Validation focuses the first invalid control", M1 #6) and it is the keyboard-only path that reaches it: with an empty primary the Create button is disabled, so Cmd/Ctrl+Enter is the only way to hit this branch — the very flow where focus feedback matters. Title errors (focused Input) and details errors (region has `tabIndex={-1}`) work; only primary is broken. No test covers dialog validation focus, which is why this survived.

Fix: focus the mounted `.cm-content` (e.g. `[role="textbox"]` or `.cm-content[aria-label]`) and fall back to the region div when the editor is unmounted (inactive row showing "Edit source").

### B2 — Activating an inactive row editor drops keyboard focus entirely

`MarkdownAuthoringField.tsx:104-108` — clicking "Edit source" (line 182) calls `write()` → `activation.activate(fieldKey)`; the fallback div containing the focused button unmounts and the browser moves focus to `<body>`. The effect at lines 97-106 only refocuses on a preview→write return (`returningToWrite`), and with `mode` already `"write"` the `mounted` false→true transition returns early — the newly mounted editor is never focused. A keyboard user adding a requirement/acceptance/follow-up row then loses their place and must re-Tab from the top of the dialog. Same fix family as B1: on the mounted transition (or after `write()`), `requestAnimationFrame(() => editor.current?.focus())`.

## Should-fix

### S1 — FoundationWizard migration silently drops revision provenance

`FoundationWizard.tsx:221,229` replaces create+revise with one `store.create`, which deletes the `{ note: "From the approved foundation" }` the removed revise calls carried. The wire supports it — `project/work/create` params accept optional `note` (`project-work-methods.ts:1061-1074`) — but `CreateWorkInput` (`store.ts:175-180`) has no `note` field, so it cannot be forwarded. This contradicts the plan's boundary claim that the migration "changes no Design behavior". Remedy: add optional `note` to `CreateWorkInput`, forward it in `store.create()`, pass it from `FoundationWizard`.

### S2 — Raw zod messages surface as person-facing errors

`create-draft.ts:277` (`parsed.error.issues[0]?.message`) feeds protocol parse failures straight into the dialog. Reachable with honest input: a phase with selected Tasks but an empty name, a boundary rule without a scope, or a risk control without a summary all serialize to schema-invalid bodies (e.g. `phases[].name` is `min(1)`), and the dialog shows `"String must contain at least 1 character(s)"` (zod 3.25.76 default). Violates the AGENTS floor "Errors are written for a person". Remedy: person-written guards in `validateCreateDraft` for these known shapes (mirroring the existing design notes guard at line 268), or map schema issues to field labels.

## Nonblocking

- **Test gaps vs the M1 acceptance list.** (a) No dialog-level test of validation errors or focus (which is exactly why B1/S2 are invisible to the suite). (b) Acceptance #4 ("switching through all kinds preserves title, prose, rows, Write/Preview mode and visited-editor selection") is exercised only for spec↔plan title+primary in `dialogs.test.tsx`; rows, Write/Preview mode and the other three kinds are untested across switches. (c) Acceptance #5's "preview causes zero requests" is unasserted. (d) The dialog success path (toast, tab switch, selection, draft reset) has no test — a pre-existing gap the new surface widens.
- **Structure.** The body-first seam, the pure `create-draft.ts` module, and the per-kind `MarkdownEditorActivationProvider` (≤5 editors, one per kind, primary defaulting active in tree order) are the right shapes; no file approaches 1k lines (273/232/207/113/281). `FoundationWizard` is a genuine complexity deletion (create+revise → one create), not a reshuffle. No structural blockers.
- **Minor.** Unused `Textarea` import (`CreateKindFields.tsx:13`). `updateDraft` clears *all* field errors on any edit (`CreateDialog.tsx:102-106`) rather than only the now-obsolete one as the plan words it — harmless since submit revalidates, and the host refusal is correctly preserved. The 8-row `MAX_CREATE_ROWS` cap is stricter than the schema and recorded only in a code comment, not the plan. Small duplication: Spec and Task acceptance-row UIs are near-identical and could share a row component. `KIND_PURPOSE` could live beside `KIND_FIELD` in `vocabulary.ts`. `PlanCreateFields`/`TaskCreateFields` single-line JSX chains (300+ chars) hurt scanning. Doc nit: the plan's grammar section still says "**Add details** reveals optional structured fields" while the approved correction (`STATUS_DETAILED.md:13`) required visible structure before disclosure — the implementation follows the correction.

## Verdict

Not approved as-is. B1 and B2 are concrete accessibility defects introduced by this change and B1 contradicts a stated M1 acceptance behavior; S1 and S2 are small, well-bounded regressions with obvious remedies. Everything else — byte-exact Markdown, typed bodies, fake-artifact bans, pending/stale/scope fencing, slash-command invariance, dependency pins, bounded editor mounting — checks out against code, schema, and the green suites above. One focused fix round (B1, B2, S1, S2 plus a validation-error dialog test) should clear approval without re-opening the structural review.
