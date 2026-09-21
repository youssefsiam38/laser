/**
 * The external trees the import adapters read (M21-T21). Not a test file.
 *
 * Each one is written the way the tool that owns the layout documents it, so
 * the adapters are tested against the shape they will actually meet: Spec
 * Kit's numbered feature directories, OpenSpec's `specs/` and `changes/`, a
 * `PLAN.md` of milestone tables, and plain Markdown with front matter.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeFile(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

/** `specs/001-phone-review/{spec,plan,tasks}.md`, as Spec Kit writes them. */
export function writeSpecKit(root: string): void {
  writeFile(root, "LICENSE", "MIT License\n\nCopyright (c) 2026\n");
  writeFile(
    root,
    "specs/001-phone-review/spec.md",
    [
      "# Phone review",
      "",
      "Reviewers cannot approve a design away from their desk.",
      "",
      "## User Scenarios & Testing",
      "",
      "### Acceptance Scenarios",
      "",
      "- **Given** an open gate, **When** the reviewer opens it on a phone, **Then** the decision is one tap away.",
      "",
      "## Requirements",
      "",
      "- **FR-001**: System MUST show the gate decision above the fold.",
      "- **FR-002**: System SHOULD keep the reviewer's place when the screen rotates.",
      "",
      "## Success Criteria",
      "",
      "- A gate can be approved at 320px.",
      "",
      "## Out of Scope",
      "",
      "- Editing the canvas on a phone.",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "specs/001-phone-review/plan.md",
    [
      "# Phone review plan",
      "",
      "Ship the review footer first, then the gate card.",
      "",
      "## Technical Context",
      "",
      "The workspace already reads gates from the host.",
      "",
      "## Testing",
      "",
      "- pnpm verify",
      "",
      "## Risks",
      "",
      "- The footer overlaps the keyboard on small screens.",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "specs/001-phone-review/tasks.md",
    [
      "# Tasks",
      "",
      "- [ ] T001 Make the review footer sticky",
      "- [ ] T002 [P] [US1] Move the gate decision above the fold",
      "- [x] T003 Add the 320px layout test",
      "",
    ].join("\n"),
  );
  writeFile(root, "specs/001-phone-review/notes.txt", "not markdown\n");
}

/** `openspec/specs/<capability>/spec.md` and a change beside it. */
export function writeOpenSpec(root: string): void {
  writeFile(
    root,
    "openspec/specs/review/spec.md",
    [
      "# Review",
      "",
      "## Purpose",
      "",
      "Reviewing is how a person decides, and it must be possible anywhere.",
      "",
      "## Requirements",
      "",
      "### Requirement: A gate records who decided it",
      "",
      "The system SHALL record the person and the exact revisions a decision covers.",
      "",
      "#### Scenario: Approving a brief gate",
      "",
      "- **WHEN** a person approves the brief gate",
      "- **THEN** the approval records every covered revision digest",
      "",
      "### Requirement: An agent never approves",
      "",
      "#### Scenario: An agent tries to approve",
      "",
      "- **WHEN** an agent sends an approval",
      "- **THEN** the system refuses it",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "openspec/changes/add-phone-review/proposal.md",
    [
      "# Add phone review",
      "",
      "## Why",
      "",
      "Reviewers are not at their desks when a gate opens.",
      "",
      "## What Changes",
      "",
      "- A sticky review footer at phone widths",
      "- The gate decision above the fold",
      "",
      "## Impact",
      "",
      "- Touches the workspace shell only",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "openspec/changes/add-phone-review/tasks.md",
    ["## 1. Footer", "", "- [ ] 1.1 Make the review footer sticky", "- [ ] 1.2 Test the 320px layout", ""].join("\n"),
  );
  writeFile(
    root,
    "openspec/changes/add-phone-review/design.md",
    ["# Phone review approach", "", "Reuse the desktop gate card and re-flow it.", "", "## Verification", "", "- pnpm verify", ""].join("\n"),
  );
}

/** A `PLAN.md` written the way this repository writes one. */
export function writePlanMd(root: string, name = "PLAN.md"): void {
  writeFile(
    root,
    name,
    [
      "# Plan",
      "",
      "## M40 · Phone review",
      "",
      "Goal: make a gate decidable from a phone.",
      "",
      "| Task | Title | Depends on | Acceptance |",
      "| --- | --- | --- | --- |",
      "| M40-T1 | Sticky review footer | M39-T2 | the footer is reachable with one thumb at 320px |",
      "| M40-T2 | Gate decision above the fold | M40-T1 | the decision is visible without scrolling |",
      "",
      "## M41 · Offline review",
      "",
      "Goal: read a gate with no connection.",
      "",
      "| Task | Title | Depends on | Acceptance |",
      "| --- | --- | --- | --- |",
      "| M41-T1 | Cache the open gates | M40-T2 | an opened gate is readable offline |",
      "",
    ].join("\n"),
  );
}

/** Plain Markdown that declares what each file is. */
export function writeFrontMatterMarkdown(root: string): void {
  writeFile(
    root,
    "docs/phone-review.md",
    [
      "---",
      "kind: spec",
      'title: "Phone review, end to end"',
      "licence: Apache-2.0",
      "---",
      "",
      "# Phone review, end to end",
      "",
      "A reviewer decides from wherever they are.",
      "",
      "## Requirements",
      "",
      "- The decision MUST be one tap away.",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "docs/sticky-footer.md",
    ["---", "kind: task", "---", "", "# Sticky footer", "", "## Outcome", "", "The review footer stays within thumb reach.", ""].join("\n"),
  );
  writeFile(root, "docs/readme.md", "# Notes\n\nNo front matter, so nothing to import.\n");
}
