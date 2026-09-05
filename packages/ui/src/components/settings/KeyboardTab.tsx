"use client";
/**
 * Settings → Keyboard (M4-T7, the keybindings half).
 *
 * Every key the app itself answers to, in one place, drawn from the same
 * `modKey()` the command palette uses so a Mac shows ⌘ and everything else
 * shows Ctrl. This is a reference, not an editor, and it says so: piorbit's
 * shortcuts are fixed in this version, and a control that pretends otherwise
 * would be a lie (docs/ux-panels.md R2).
 *
 * Pi's own `keybindings.json` is a **different file for a different program**
 * — it binds Pi's terminal UI, which this app never runs. Rebinding it from
 * here would mean writing a file a running Pi holds a lock on, which
 * `docs/architecture.md` rules out; the closing note points at the command
 * that edits it safely instead.
 */
import { useMemo } from "react";
import { Keyboard } from "lucide-react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { modKey } from "@/format";

interface Binding {
  /** Each entry is one chord; two entries mean "either of these". */
  keys: string[][];
  what: string;
  detail?: string;
}

interface BindingGroup {
  title: string;
  detail: string;
  bindings: Binding[];
}

function groups(mod: string): BindingGroup[] {
  return [
    {
      title: "Anywhere",
      detail: "Answered by the window, wherever the focus is — except inside a text field.",
      bindings: [
        { keys: [[mod, "K"]], what: "Command palette", detail: "Sessions, projects, settings and every action, searchable." },
        { keys: [[mod, "N"]], what: "New session", detail: "In the project the rail has selected." },
        { keys: [["["]], what: "Show or hide the sessions list" },
        { keys: [["]"]], what: "Show or hide telemetry", detail: "On a narrow window this opens the history sheet instead." },
        { keys: [["Esc"]], what: "Close a sheet, a dialog or the palette" },
      ],
    },
    {
      title: "Composer",
      detail: "While the cursor is in the message box. What Enter does depends on whether the agent is working.",
      bindings: [
        { keys: [["Enter"]], what: "Send", detail: "Prompts an idle session; steers one that is already working." },
        { keys: [["Shift", "Enter"]], what: "New line" },
        { keys: [[mod, "Enter"]], what: "Queue a follow-up", detail: "Runs after the current turn instead of interrupting it." },
        { keys: [["/"]], what: "Slash commands", detail: "At the start of an empty composer." },
        { keys: [["@"]], what: "Mention a file" },
        { keys: [[mod, "V"]], what: "Paste an image as an attachment" },
      ],
    },
    {
      title: "Lists and dialogs",
      detail: "Standard controls, listed because a keyboard-only path exists for all of them.",
      bindings: [
        { keys: [["↑"], ["↓"]], what: "Move through a list", detail: "The palette, the model picker, the sessions list." },
        { keys: [["←"], ["→"]], what: "Move through a row of choices", detail: "Theme cards, hues, and every segmented control in Appearance." },
        { keys: [["Enter"]], what: "Choose the highlighted row" },
        { keys: [["Tab"]], what: "Next control", detail: "Focus is always visible; nothing is reachable by mouse only." },
      ],
    },
  ];
}

export function KeyboardTab() {
  const mod = modKey();
  const list = useMemo(() => groups(mod), [mod]);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-8 px-6 py-6">
        <p className="text-xs leading-5 text-ink-3">
          Everything the mouse can do has a key. These are fixed in this version; nothing here is editable yet.
        </p>

        {list.map((group) => (
          <section key={group.title} className="flex flex-col gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">{group.title}</h3>
              <p className="mt-0.5 text-xs leading-4 text-ink-3">{group.detail}</p>
            </div>
            <div className="flex flex-col rounded-lg border border-line">
              {group.bindings.map((binding, index) => (
                <div
                  key={binding.what}
                  className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 ${index > 0 ? "hairline-t" : ""}`}
                >
                  {/* A fixed key column, so every description starts on the
                      same vertical line rather than wherever its chord ends. */}
                  <span className="flex w-28 shrink-0 items-center gap-1.5">
                    {binding.keys.map((chord, chordIndex) => (
                      <span key={chord.join("+")} className="flex items-center gap-1.5">
                        {chordIndex > 0 && <span className="text-xs text-ink-3">or</span>}
                        <KbdGroup>
                          {chord.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      </span>
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{binding.what}</span>
                    {binding.detail && <span className="mt-0.5 block text-xs leading-4 text-ink-3">{binding.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5">
          <Keyboard aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <div className="min-w-0 text-xs leading-5 text-ink-2">
            <p className="font-medium text-ink">The agent&rsquo;s terminal keys are separate.</p>
            <p className="mt-0.5 text-ink-3">
              Running the agent in a terminal uses its own bindings file, which this app never loads. It is edited from
              a terminal, where nothing else holds it open:
            </p>
            <p className="typed mt-1.5 rounded-md bg-surface px-2 py-1 text-ink-2">piorbit pi</p>
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
