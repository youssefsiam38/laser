import { FolderPlus } from "lucide-react";
import { useState } from "react";

import { Onboarding, type OnboardingStep } from "@/components/assistant-ui/elements/onboarding";
import { modKey } from "@/format";

import { useShell } from "./shell-context.js";

export const FIRST_RUN_DISMISSED_KEY = "piorbit-first-run-dismissed";

const readDismissed = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(FIRST_RUN_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * The first-run moment (docs/ux-elements.md "Thread" → Onboarding): the host
 * is connected and knows no project yet. Three short moves, drawn by the
 * `onboarding` element in the thread column where the conversation will be.
 * "Not now" remembers itself on this device; the sessions panel's empty state
 * still offers the same button, so nothing is lost.
 */
export function FirstRun() {
  const shell = useShell();
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;

  const steps: OnboardingStep[] = [
    {
      title: "Point piorbit at a project",
      body: "A project is a directory Pi works in. Every session you start there, and every session Pi already has on disk for it, shows up in the sessions panel.",
      example: "~/code/your-app",
      exampleMono: true,
    },
    {
      title: "Talk to the agent",
      body: `Type a message and press Enter. While it works, Enter steers it mid-turn and ${modKey()}+Enter queues a follow-up for after. The line above the composer always says what the session is doing.`,
      example: "Read the failing test and fix the cause, not the assertion.",
    },
    {
      title: "Watch many at once",
      body: "Sessions across every project sit in one list, the ones that need you first. Subagents, plans and long outputs open as islands beside the conversation so you can keep typing.",
      action: {
        label: "Add a project",
        icon: <FolderPlus />,
        onClick: () => shell.setAddProjectOpen(true),
      },
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      <Onboarding
        steps={steps}
        index={index}
        onIndexChange={setIndex}
        onSkip={() => {
          try {
            globalThis.localStorage?.setItem(FIRST_RUN_DISMISSED_KEY, "1");
          } catch {
            /* this tab only */
          }
          setDismissed(true);
        }}
      />
    </div>
  );
}
