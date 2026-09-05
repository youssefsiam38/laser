import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { useAuiState } from "@assistant-ui/react";
import { FolderGit2 } from "lucide-react";

import {
  EmptyState as EmptyStateRoot,
  EmptyStateDescription,
  EmptyStateEyebrow,
  EmptyStateGreeting,
  EmptyStateSuggestion,
  EmptyStateSuggestions,
} from "@/components/assistant-ui/elements/empty-state";
import { useShellOptional } from "@/components/shell/shell-context";
import { Button } from "@/components/ui/button";
import { shortCwd } from "@/format";
import { useLaserStable, useSessionMeta } from "@/runtime";

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
 *
 * With no project there is no session to start — `threadList.initialize`
 * refuses, and the refusal used to go nowhere: the screen said "Send a message
 * to start one", the composer took the message, and Enter did nothing at all.
 * So this state says the one true next step and offers the verb for it, and
 * the composer beside it is disabled with the same sentence as its placeholder.
 */
export function EmptyState() {
  const { currentProject } = useLaserStable();
  const { session } = useSessionMeta();
  const shell = useShellOptional();
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const cwd = session?.cwd ?? currentProject;
  const name = cwd ? shortCwd(cwd) : PRODUCT_DISPLAY_NAME;

  if (!cwd) {
    return (
      <EmptyStateRoot>
        <div className="flex flex-col gap-2">
          <EmptyStateGreeting>{name}</EmptyStateGreeting>
          <EmptyStateDescription>
            Open a project to start. A project is a folder on this computer the agent works in; every session you start
            there, and every session already saved for it, shows up in the sessions list.
          </EmptyStateDescription>
        </div>
        {shell && (
          <div>
            <Button size="sm" onClick={() => shell.setAddProjectOpen(true)}>
              <FolderGit2 /> Add a project
            </Button>
          </div>
        )}
      </EmptyStateRoot>
    );
  }

  return (
    <EmptyStateRoot>
      <div className="flex flex-col gap-2">
        <EmptyStateEyebrow title={cwd}>{cwd}</EmptyStateEyebrow>
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
