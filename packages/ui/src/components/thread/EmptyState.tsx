import { useAui, useAuiState } from "@assistant-ui/react";
import { ChevronRight } from "lucide-react";

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
 * First-run state of a thread: the project name in display type, one line of
 * context, three suggested prompts as hairline-separated rows. Left-aligned
 * like the transcript (DESIGN.md "Do not").
 */
export function EmptyState() {
  const aui = useAui();
  const { currentProject } = usePiorbitStable();
  const { session } = useSessionMeta();
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const cwd = session?.cwd ?? currentProject;
  const name = cwd ? shortCwd(cwd) : "piorbit";

  const send = (prompt: string) => {
    aui.composer.setText(prompt);
    aui.composer.send();
  };

  return (
    <div data-slot="empty-state" className="my-auto flex flex-col gap-8 py-12">
      <div className="flex flex-col gap-2">
        {cwd ? <p className="typed truncate text-ink-3">{cwd}</p> : null}
        <h1 className="text-xl font-semibold text-ink">{name}</h1>
        <p className="text-md text-ink-2">
          {session ? "New session. What should the agent work on?" : "No session open. Send a message to start one."}
        </p>
      </div>
      <ul className="flex flex-col border-t border-line" aria-label="Suggested prompts">
        {SUGGESTIONS.map((s) => (
          <li key={s.title} className="border-b border-line">
            <button
              type="button"
              disabled={disabled}
              onClick={() => send(s.prompt)}
              className="group/suggestion -mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-md px-2 py-3 text-start outline-none transition-colors duration-75 hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base font-medium text-ink">{s.title}</span>
                <span className="truncate text-sm text-ink-3">{s.prompt}</span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-3 group-hover/suggestion:text-ink"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
