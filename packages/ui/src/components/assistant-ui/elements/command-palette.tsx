"use client";
/**
 * Command palette — `Cmd+K` (docs/ux-elements.md "Composer"). Installed from
 * `elements-command-palette` and restyled to DESIGN.md tokens. The keyboard
 * model is the registry's: a combobox whose `aria-activedescendant` moves the
 * highlight without moving focus, arrows wrap, Enter runs.
 *
 * Divergences from the registry copy:
 *   - Commands carry an optional `detail` line and an optional `icon`; a
 *     session command shows its project and status.
 *   - Matching covers the label, the detail and the group, so "settings" or a
 *     project name finds the row.
 *   - Colours, sizes and durations read tokens; the frame is the app's
 *     `floating` surface, mounted inside a `Dialog` by the shell.
 */
import { SearchIcon, type LucideIcon } from "lucide-react";
import { useEffect, useId, type ComponentProps, type KeyboardEvent } from "react";

import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

import { field, mono } from "./surfaces.js";

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keys?: readonly string[] | undefined;
  detail?: string | undefined;
  icon?: LucideIcon | undefined;
  disabled?: boolean | undefined;
}

export interface CommandPaletteProps extends Omit<ComponentProps<"div">, "children"> {
  commands: readonly PaletteCommand[];
  query: string;
  activeId: string;
  onQueryChange?: ((query: string) => void) | undefined;
  onActiveChange?: ((id: string) => void) | undefined;
  onRun?: ((id: string) => void) | undefined;
  placeholder?: string | undefined;
}

export function matchesCommand(command: PaletteCommand, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${command.label} ${command.detail ?? ""} ${command.group}`.toLowerCase();
  return needle.split(/\s+/).every((term) => hay.includes(term));
}

export function CommandPalette({
  commands,
  query,
  activeId,
  onQueryChange,
  onActiveChange,
  onRun,
  placeholder = "Type a command or a session name",
  className,
  ...props
}: CommandPaletteProps) {
  const listId = useId();
  const optionId = (id: string) => `${listId}-${id}`;
  const matches = commands.filter((command) => matchesCommand(command, query));
  const groups = [...new Set(matches.map((command) => command.group))];
  // display order, which is grouped and so differs from the filter order
  const ordered = groups.flatMap((group) => matches.filter((command) => command.group === group));

  const move = (delta: number) => {
    if (ordered.length === 0) return;
    const at = ordered.findIndex((command) => command.id === activeId);
    // activeId can be filtered out by the query; start from the edge the key implies
    const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
    const next = ordered[(from + delta + ordered.length) % ordered.length];
    if (next) onActiveChange?.(next.id);
  };

  // aria-activedescendant moves the highlight without moving focus, and only
  // focus scrolls; the list is short enough to walk the active row out of view.
  useEffect(() => {
    document.getElementById(optionId(activeId))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is derived from listId
  }, [activeId, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = ordered.find((command) => command.id === activeId);
      if (active && !active.disabled) onRun?.(active.id);
    }
  };

  return (
    <div data-slot="command-palette" className={cn("flex w-full flex-col overflow-hidden", className)} {...props}>
      <div className="flex h-12 items-center gap-2.5 px-3.5 hairline-b">
        <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange?.(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={ordered.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={ordered.some((command) => command.id === activeId) ? optionId(activeId) : undefined}
          className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
        />
        <Kbd>esc</Kbd>
      </div>

      <div id={listId} role="listbox" aria-label="Commands" className="flex max-h-[min(24rem,60vh)] flex-col overflow-y-auto p-1.5">
        {groups.map((group) => (
          <div key={group} role="group" aria-label={group} className="flex flex-col">
            <span aria-hidden="true" className="eyebrow px-2 pt-2 pb-1">
              {group}
            </span>
            {matches
              .filter((command) => command.group === group)
              .map((command) => {
                const Icon = command.icon;
                const active = command.id === activeId;
                return (
                  <button
                    key={command.id}
                    id={optionId(command.id)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={active}
                    aria-disabled={command.disabled || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => !active && onActiveChange?.(command.id)}
                    onClick={() => !command.disabled && onRun?.(command.id)}
                    className={cn(
                      "flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors duration-(--motion-instant)",
                      active ? "bg-surface-2" : "hover:bg-[color-mix(in_oklab,var(--surface-2)_60%,transparent)]",
                      command.disabled && "opacity-45",
                    )}
                  >
                    {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-3" /> : null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-ink">{command.label}</span>
                      {command.detail && <span className="truncate text-xs text-ink-3">{command.detail}</span>}
                    </span>
                    {command.keys && command.keys.length > 0 && (
                      <span className="flex shrink-0 gap-1">
                        {command.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        ))}
        {matches.length === 0 && (
          <span className={cn(field, "m-1 block rounded-lg px-2 py-4 text-center text-sm break-words text-ink-3")}>
            Nothing matches “{query}”.{" "}
            <span className={mono}>Try a command, a session or a project.</span>
          </span>
        )}
      </div>
    </div>
  );
}
