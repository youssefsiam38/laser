"use client";
/**
 * Case A, in its own section of the Design tab (M21-T14).
 *
 * A design that has a foundation gets the wizard — the ordered steps, the
 * samples, the licence checks, Approve and the Plan — and a design that has
 * none gets the honest slot with the one action that can start one. Both
 * live beside the other four sections (M21-T13); neither replaces them.
 */
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DesignBody, DesignIndex } from "@lasercode/protocol";

import { FoundationWizard } from "./FoundationWizard.js";
import type { DesignIndexAccess } from "./DesignIndexPanel.js";
import type { WorkBodyContext } from "../project-work/bodies/context.js";

/** What "Start a foundation" puts in the composer, naming this exact design. */
export function foundationRequestFor(workKey: string): string {
  return `Start a design foundation on @${workKey}: propose the first step (principles) with propose_foundation.`;
}

/** What a foundation is, for a design that has none yet. */
export const FOUNDATION_PENDING_SENTENCE =
  "A foundation is what a project with no interface code starts from: principles, then tokens, themes, type, spacing, motion, icons and the core component contracts, each one proposed and edited here before anything is built.";

/** Why the button sends rather than starts: the proposal is the model's work. */
export const FOUNDATION_START_SENTENCE =
  "Starting one puts the request in the composer with this design's key. The steps are proposed in the conversation — nothing is written here until one comes back, and nothing is written into the project until a build implements it.";

export interface FoundationSectionProps {
  body: DesignBody;
  context: WorkBodyContext;
  access: DesignIndexAccess;
  editable: boolean;
  /** True while the detail holds edits that have not been stored. */
  dirty: boolean;
  index: DesignIndex | undefined;
  onChange: (next: DesignBody["foundation"] & object) => void;
  onSave: () => Promise<void> | void;
  onStart: () => void;
}

export function FoundationSection({ body, context, access, editable, dirty, index, onChange, onSave, onStart }: FoundationSectionProps) {
  const foundation = body.foundation;
  if (!foundation) {
    return (
      <div data-slot="design-foundation" className="flex min-w-0 flex-col gap-3">
        <div role="status" className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line p-3">
          <p className="text-sm font-medium text-ink">This design has no foundation</p>
          <p className="text-xs leading-xs text-ink-2">{FOUNDATION_PENDING_SENTENCE}</p>
        </div>
        <FoundationStart access={access} editable={editable} onStart={onStart} />
      </div>
    );
  }
  return (
    <div data-slot="design-foundation" className="flex min-w-0 flex-col gap-4">
      <FoundationWizard
        body={body}
        foundation={foundation}
        context={context}
        editable={editable}
        dirty={dirty}
        onChange={onChange}
        onSave={onSave}
        {...(index ? { index } : {})}
      />
    </div>
  );
}

/**
 * "Start a foundation" — the header override of `docs/design-phase.md`, which
 * a person may take in any project, not only one the index says is empty.
 *
 * It sends nothing and writes nothing: the steps are proposed by the model
 * through `propose_foundation`, so the request goes into the composer naming
 * this exact design, and the person sends it. What is said about this
 * project's own state is said only once the index has actually answered —
 * while it is still being read, or when reading it failed, this offers the
 * action without claiming anything about the project.
 *
 * And what "no index" means is exactly that: no index has been built here. It
 * is **not** evidence that the project has no interface code — only an index
 * build reads the source. The copy therefore never calls an unindexed project
 * greenfield; the foundation stays available either way, as the override it
 * is.
 */
export function FoundationStart({ access, editable, onStart }: { access: DesignIndexAccess; editable: boolean; onStart: () => void }) {
  const state = access.state;
  const ground =
    state.kind === "loading"
      ? "Reading this project's design system…"
      : state.kind === "absent"
        ? "This project has no design index yet, so there is nothing here to compose from. Whether it has interface code to index is not something this says — building the index is what answers that."
        : state.kind === "ready"
          ? "This project already has a design index, so new work is normally composed from it. A foundation is still yours to start — it proposes a new language rather than reading the one that is there."
          : state.kind === "error"
            ? `This project's design system could not be read: ${state.message}`
            : state.detail;
  return (
    <div data-slot="foundation-start" className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2">
      <p role="status" className="text-xs leading-xs text-ink-2">
        {ground}
      </p>
      <p className="text-xs leading-xs text-ink-3">{FOUNDATION_START_SENTENCE}</p>
      {editable ? (
        <Button size="sm" variant="outline" className="self-start" onClick={onStart}>
          <Compass />
          Start a foundation
        </Button>
      ) : null}
    </div>
  );
}
