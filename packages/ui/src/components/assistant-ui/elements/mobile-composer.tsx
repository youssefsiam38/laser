"use client";
/**
 * Mobile composer — the phone composer (docs/ux-elements.md "Thread", M7-T2).
 * Installed from `elements-mobile-composer` and rebuilt on the runtime
 * primitives so a phone and a desktop type into the *same* composer.
 *
 * The registry file is a specimen with its own `<input>`, quick-action chips
 * and a drag handle for a sheet. What survives is its layout — thumb-sized
 * targets at both ends of a pill, the input between them — which is what a
 * phone needs. What was removed, and why:
 *   - the `<input>`: `ComposerPrimitive.Input` is the one text field; it
 *     already gives 16px on touch (`globals.css`), plain Enter as a newline
 *     on a touch keyboard, paste-to-attach and dictation.
 *   - the quick-action chips: Pi has no canned prompts to offer. Their row
 *     survives as the `above` slot, and it carries the controls a phone
 *     would otherwise lose — model, thinking level, context ring — so nothing
 *     the desktop composer offers is unreachable on a phone (DESIGN.md
 *     "Both widths").
 *   - the drag handle and "return to send": this is not a sheet, and on a
 *     touch keyboard Return is a newline.
 *   - the keyboard inset: the thread footer already rides `--kb`, driven by
 *     `visualViewport` and combined with the safe area through `max()`
 *     (DESIGN.md "Layout"), so the composer inherits it.
 *
 * The 44px hit targets come from `min-h-11`/`size-11` on the two buttons, so
 * the pill is 44px tall too (DESIGN.md "Legibility floor").
 */
import { ComposerPrimitive } from "@assistant-ui/react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { field } from "./surfaces.js";

export interface MobileComposerProps extends Omit<ComponentProps<"div">, "children"> {
  /** A row above the pill: model, thinking, context. */
  above?: ReactNode;
  /** The leading control, usually the attach button. */
  leading?: ReactNode;
  /** Controls inside the pill after the text, usually the microphone. */
  inline?: ReactNode;
  /** The trailing control, usually send / stop. */
  trailing: ReactNode;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  onInputKeyDown?: ComponentProps<typeof ComposerPrimitive.Input>["onKeyDown"];
}

export function MobileComposer({ above, leading, inline, trailing, placeholder, disabled, onInputKeyDown, className, ...props }: MobileComposerProps) {
  return (
    <div data-slot="mobile-composer" className={cn("flex flex-col gap-2", className)} {...props}>
      {above && <div className="flex min-h-8 items-center gap-1 overflow-x-auto px-1 scrollbar-none">{above}</div>}
      <div className="flex items-end gap-2">
      {leading}
      <div className={cn(field, "flex min-h-11 min-w-0 flex-1 items-end gap-1 rounded-full py-1.5 ps-4 pe-1.5")}>
        <ComposerPrimitive.Input
          dir="auto"
          rows={1}
          maxRows={6}
          aria-label="Message"
          placeholder={placeholder ?? "Message"}
          submitMode="enter"
          cancelOnEscape={false}
          unstable_insertNewlineOnTouchEnter
          disabled={disabled}
          onKeyDown={onInputKeyDown}
          className="min-h-8 w-full resize-none self-center bg-transparent py-1 text-base leading-base text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
        />
        {inline}
      </div>
      {trailing}
      </div>
    </div>
  );
}

/** A 44px round control for either end of the pill. */
export function MobileComposerButtonClass(active = false): string {
  return cn(
    "size-11 shrink-0 rounded-full [&_svg:not([class*='size-'])]:size-5",
    active ? "" : "bg-surface-2 text-ink-2 hover:text-ink",
  );
}
