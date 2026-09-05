import { useAuiState } from "@assistant-ui/react";

import {
  EmptyState as EmptyStateRoot,
  EmptyStateDescription,
  EmptyStateEyebrow,
  EmptyStateGreeting,
  EmptyStateSuggestion,
  EmptyStateSuggestions,
} from "@/components/assistant-ui/elements/empty-state";
import { shortCwd } from "@/format";
import { usePiorbitStable, useSessionMeta } from "@/runtime";

const SUGGESTIONS: ReadonlyArray<{ title: string; prompt: string }> = [
  {
    title: "Explain the architecture",
    prompt: "Walk me through this project's architecture: the packages, how they depend on each other, and where the entry points are.",
  },
  {
    title: "Review my uncommitted changes",
    prompt: "Review the uncommitted changes in this repository. Point out bugs, missing tests, and anything that should not ship.",
  },
  {
    title: "Fix the failing tests",
    prompt: "Run the test suite, find the failing tests, and fix them. Explain each fix briefly.",
  },
];

/**
 * First-run state of a thread (the `empty-state` element, fed from the open
 * session): the project name in display type, one line of context, three
 * suggested prompts as hairline rows. Left-aligned like the transcript.
 */
export function EmptyState() {
  const { currentProject } = usePiorbitStable();
  const { session } = useSessionMeta();
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const cwd = session?.cwd ?? currentProject;
  const name = cwd ? shortCwd(cwd) : "piorbit";

  return (
    <EmptyStateRoot>
      <div className="flex flex-col gap-2">
        {cwd ? <EmptyStateEyebrow title={cwd}>{cwd}</EmptyStateEyebrow> : null}
        <EmptyStateGreeting>{name}</EmptyStateGreeting>
        <EmptyStateDescription>
          {session ? "New session. What should the agent work on?" : "No session open. Send a message to start one."}
        </EmptyStateDescription>
      </div>
      <EmptyStateSuggestions>
        {SUGGESTIONS.map((s, i) => (
          <EmptyStateSuggestion key={s.title} index={i} title={s.title} prompt={s.prompt} disabled={disabled} />
        ))}
      </EmptyStateSuggestions>
    </EmptyStateRoot>
  );
}
