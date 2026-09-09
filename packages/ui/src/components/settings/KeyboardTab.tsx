"use client";
/**
 * Settings → Help and shortcuts (M4-T7, the keybindings half).
 *
 * Every key the app itself answers to, in one place, drawn from the same
 * `modKey()` the command palette uses so a Mac shows ⌘ and everything else
 * shows Ctrl. This is a reference, not an editor, and it says so: laser's
 * shortcuts are fixed in this version, and a control that pretends otherwise
 * would be a lie.
 *
 * Below it, the agent's own bindings — its actions and its editor keys, read
 * and written through `pi/keybindings/get|set`, which goes to the agent's own
 * `KeybindingsManager`. Those *are* editable: pick a row, press the chord, and
 * it is saved. Reset puts the agent's default back rather than writing the
 * current default into the file, so a later agent that changes its own mind
 * still reaches you.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, Keyboard, RotateCcw } from "lucide-react";
import type { KeybindingsSnapshot } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { modKey } from "@/format";
import { useLaserStable } from "@/runtime";
import { cn } from "@/lib/utils";

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
        { keys: [[mod, "F"]], what: "Find in this conversation", detail: "Includes folded reasoning and tools. Enter / Shift+Enter moves between matches; Esc closes." },
        { keys: [[mod, "Shift", "F"]], what: "Search all sessions", detail: "Recent history first. Search older periods on demand; your messages rank before assistant replies and tool activity." },
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
        { keys: [["Enter"]], what: "Send", detail: "Prompts an idle session. While the agent is working it joins the queue above the composer and goes in when the turn ends." },
        { keys: [["Shift", "Enter"]], what: "New line" },
        { keys: [[mod, "Enter"]], what: "Steer", detail: "Interrupts the working agent with this message instead of waiting. The Steer button on a queued message does the same thing." },
        { keys: [["/"]], what: "Slash commands", detail: "At the start of an empty composer." },
        { keys: [["↑"], ["↓"], ["PageUp"], ["PageDown"]], what: "Navigate composer suggestions", detail: "Selection stays visible. Tab or Enter selects; Escape or an outside click closes without changing your draft." },
        { keys: [["Alt", "O"]], what: "Open selected skill or prompt source", detail: "While suggestions are open. Desktop uses your default Markdown application; browser and phone copy the source path." },
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

export function KeyboardTab({ cwd }: { cwd?: string | undefined }) {
  const mod = modKey();
  const list = useMemo(() => groups(mod), [mod]);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-8 px-6 py-6">
        <p className="text-xs leading-5 text-ink-3">
          The compact chat composer keeps these reminders here instead of reserving a permanent row beneath every message box.
          The window&rsquo;s own keys are fixed in this version; the agent&rsquo;s, further down, you can change.
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

        <AgentKeys cwd={cwd} />
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// The agent's own bindings (`pi/keybindings/*`).
//
// One row per action: what it does, the chord in force, and — on hover or
// focus — Change and Reset. Changing captures the next chord you press, so
// nothing has to be typed in the syntax the file uses.
// ---------------------------------------------------------------------------

/** Section id → what that half of the agent is. Unknown ids show as themselves. */
const SECTION_TITLES: Record<string, { title: string; detail: string }> = {
  app: {
    title: "The agent's actions",
    detail: "Interrupting, switching model, moving through the session tree. In force wherever the agent runs.",
  },
  tui: {
    title: "The agent's editor and lists",
    detail: "Cursor movement, deletion and selection inside the agent's own text box.",
  },
};

/** Browser key event → the agent's own chord spelling (`ctrl+shift+f`, `up`). */
export function chordOf(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | undefined {
  const base = baseKeyOf(event.key);
  if (base === undefined) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  // Shift is only meaningful next to a key that is not already shifted into
  // another character: `shift+f` is a chord, `shift+$` is just `$`.
  if (event.shiftKey && (base.length > 1 || /^[a-z0-9]$/.test(base))) parts.push("shift");
  if (event.metaKey) parts.push("super");
  parts.push(base);
  return parts.join("+");
}

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "escape",
  Enter: "enter",
  Tab: "tab",
  " ": "space",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
};

function baseKeyOf(key: string): string | undefined {
  // A modifier on its own is not a chord; keep waiting for the real key.
  if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return undefined;
  const named = NAMED_KEYS[key];
  if (named) return named;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key.toLowerCase();
  if (key.length === 1) return key.toLowerCase();
  return undefined;
}

function AgentKeys({ cwd }: { cwd?: string | undefined }) {
  const { client } = useLaserStable();
  const [snapshot, setSnapshot] = useState<KeybindingsSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState<string>();

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    client
      .request("pi/keybindings/get", { cwd })
      .then((result) => {
        if (!cancelled) {
          setSnapshot(result.keybindings);
          setError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [client, cwd]);

  const apply = useCallback(
    async (change: { id: string; op: "set"; keys: string[] } | { id: string; op: "reset" }) => {
      if (!cwd) return;
      setBusy(true);
      setError(undefined);
      try {
        const result = await client.request("pi/keybindings/set", { cwd, changes: [change] });
        setSnapshot(result.keybindings);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
        setCapturing(undefined);
      }
    },
    [client, cwd],
  );

  const sections = useMemo(() => {
    const bySection = new Map<string, KeybindingsSnapshot["bindings"]>();
    for (const binding of snapshot?.bindings ?? []) {
      const list = bySection.get(binding.section) ?? [];
      list.push(binding);
      bySection.set(binding.section, list);
    }
    return [...bySection].sort(([a], [b]) => (a === "app" ? -1 : b === "app" ? 1 : a < b ? -1 : 1));
  }, [snapshot]);

  // Keyboard settings are the agent's, not a project's — but only a running
  // worker can read the agent's own table, and a worker belongs to a project.
  if (!cwd) {
    return (
      <Note>
        <p className="font-medium text-ink">The agent&rsquo;s keys need a project open.</p>
        <p className="mt-0.5 text-ink-3">
          They are the same on every project — the agent keeps one file — but reading them means asking the agent, and
          the agent runs inside a project. Open one and come back.
        </p>
      </Note>
    );
  }

  if (error && !snapshot) {
    return (
      <Note tone="danger">
        <p className="font-medium text-ink">The agent&rsquo;s keys could not be read.</p>
        <p className="mt-0.5 text-ink-3">{error}</p>
      </Note>
    );
  }

  if (!snapshot) {
    return (
      <Note>
        <p className="text-ink-3">Reading the agent&rsquo;s keys…</p>
      </Note>
    );
  }

  return (
    <>
      {sections.map(([section, bindings]) => {
        const heading = SECTION_TITLES[section];
        return (
          <section key={section} className="flex flex-col gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">{heading?.title ?? section}</h3>
              <p className="mt-0.5 text-xs leading-4 text-ink-3">
                {heading?.detail ?? `Bindings the agent groups under “${section}”.`}
              </p>
            </div>
            <div className="flex flex-col rounded-lg border border-line">
              {bindings.map((binding, index) => (
                <AgentKeyRow
                  key={binding.id}
                  binding={binding}
                  first={index === 0}
                  writable={snapshot.writable}
                  busy={busy}
                  capturing={capturing === binding.id}
                  onCapture={() => setCapturing(binding.id)}
                  onCancel={() => setCapturing(undefined)}
                  onSet={(keys) => void apply({ id: binding.id, op: "set", keys })}
                  onReset={() => void apply({ id: binding.id, op: "reset" })}
                />
              ))}
            </div>
          </section>
        );
      })}

      {snapshot.conflicts.length > 0 && (
        <Note tone="danger">
          <p className="font-medium text-ink">Two actions share a key.</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-ink-3">
            {snapshot.conflicts.map((conflict) => (
              <li key={conflict.key}>
                <span className="typed text-ink-2">{conflict.key}</span> is bound to {conflict.ids.join(" and ")}. The
                agent will run the first of them.
              </li>
            ))}
          </ul>
        </Note>
      )}

      {!snapshot.writable && snapshot.reason && (
        <Note tone="danger">
          <p className="font-medium text-ink">These keys cannot be changed right now.</p>
          <p className="mt-0.5 text-ink-3">{snapshot.reason}</p>
        </Note>
      )}

      {error && snapshot && (
        <Note tone="danger">
          <p className="font-medium text-ink">That change was not saved.</p>
          <p className="mt-0.5 text-ink-3">{error}</p>
        </Note>
      )}

      <Note>
        <p className="font-medium text-ink">Where these live.</p>
        <p className="mt-0.5 text-ink-3">
          The agent reads them from one file, shared by every project on this machine:
        </p>
        <p className="typed mt-1.5 rounded-md bg-surface px-2 py-1 break-all text-ink-2">{snapshot.path}</p>
      </Note>
    </>
  );
}

/**
 * Change and Reset sit out of the way until the row is reached for. A coarse
 * pointer has no hover, so on touch they are simply always there — the same
 * rule the transcript's own row actions use (`hoverReveal`).
 */
const KEY_ACTION_REVEAL =
  "opacity-0 transition-opacity duration-(--motion-instant) group-hover/key:opacity-100 group-focus-within/key:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 motion-reduce:transition-none";

function AgentKeyRow({
  binding,
  first,
  writable,
  busy,
  capturing,
  onCapture,
  onCancel,
  onSet,
  onReset,
}: {
  binding: KeybindingsSnapshot["bindings"][number];
  first: boolean;
  writable: boolean;
  busy: boolean;
  capturing: boolean;
  onCapture: () => void;
  onCancel: () => void;
  onSet: (keys: string[]) => void;
  onReset: () => void;
}) {
  const captureRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (capturing) captureRef.current?.focus();
  }, [capturing]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    // Escape leaves the row alone. It is the one chord this control cannot
    // capture, and the hint under it says so rather than letting you try.
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      onCancel();
      return;
    }
    const chord = chordOf(event);
    if (chord) onSet([chord]);
  };

  return (
    <div
      className={cn(
        "group/key flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2",
        !first && "hairline-t",
        capturing && "bg-surface-2",
      )}
    >
      {/* Narrow: the chord takes its own line above the description, so the
          description gets the full width instead of a four-word ribbon.
          Wide: a fixed column, so every description starts on one line. */}
      <span className="flex w-full shrink-0 flex-wrap items-center gap-1.5 sm:w-40">
        {binding.keys.length === 0 ? (
          <span className="text-xs text-ink-3">Not bound</span>
        ) : (
          binding.keys.map((chord, chordIndex) => (
            <span key={chord} className="flex items-center gap-1.5">
              {chordIndex > 0 && <span className="text-xs text-ink-3">or</span>}
              <KbdGroup>
                {chord.split("+").map((key, keyIndex) => (
                  <Kbd key={`${key}-${keyIndex}`}>{key}</Kbd>
                ))}
              </KbdGroup>
            </span>
          ))
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{binding.description}</span>
        {/* An id is one long token with no spaces; without this it runs out
            of the card rather than wrapping. */}
        <span className="typed mt-0.5 block truncate text-ink-3" title={binding.id}>
          {binding.id}
        </span>
      </span>
      {writable && (
        <span className="flex shrink-0 items-center gap-1">
          {binding.overridden && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={onReset}
              className={KEY_ACTION_REVEAL}
            >
              <RotateCcw aria-hidden="true" />
              Reset
            </Button>
          )}
          <Button
            ref={captureRef}
            variant={capturing ? "default" : "ghost"}
            size="xs"
            disabled={busy}
            onClick={capturing ? onCancel : onCapture}
            onKeyDown={onKeyDown}
            onBlur={capturing ? onCancel : undefined}
            aria-label={capturing ? `Press the new key for ${binding.description}` : `Change the key for ${binding.description}`}
            className={cn(!capturing && KEY_ACTION_REVEAL)}
          >
            {capturing ? "Press a key… (Esc cancels)" : "Change"}
          </Button>
        </span>
      )}
    </div>
  );
}

/** The standing note block this screen uses for anything that is not a row. */
function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" }) {
  const Icon = tone === "danger" ? AlertTriangle : Keyboard;
  return (
    <section className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-danger" : "text-ink-3")} />
      <div className="min-w-0 text-xs leading-5 text-ink-2">{children}</div>
    </section>
  );
}
