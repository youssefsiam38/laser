"use client";
/**
 * Settings panel — the settings screen's controls (docs/ux-elements.md
 * "Thread" → Settings, M4-T2). Installed from `elements-settings-panel` and
 * restyled to DESIGN.md tokens.
 *
 * The registry file is a chat app's settings card: a model segmented control,
 * a system prompt, a temperature slider and a few toggles. laser's settings
 * are Pi's, generated from the pinned Pi's catalogue as dozens of typed
 * fields at two scopes (`components/settings/SettingsForm.tsx`), so the card
 * as a whole does not fit. What fits — and what the form lacked — is its
 * switch: a real `role="switch"` with a sliding thumb, and the label/detail
 * row it sits in. Those are kept here as `SettingsSwitch` and
 * `SettingsToggleRow`, and `fields.tsx` draws every boolean setting with
 * them. The model, prompt and temperature controls were removed: the
 * catalogue describes those as fields of their own kind.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export interface SettingsSwitchProps extends Omit<ComponentProps<"button">, "onChange" | "children"> {
  checked: boolean;
  onCheckedChange?: ((checked: boolean) => void) | undefined;
}

/** A switch: `--live` when on, `--line` when off; the thumb slides. */
export function SettingsSwitch({ checked, onCheckedChange, disabled, className, ...props }: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-slot="settings-switch"
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 outline-none",
        "transition-colors duration-(--motion-fast) motion-reduce:transition-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        "disabled:cursor-not-allowed disabled:opacity-45",
        checked ? "bg-live" : "bg-line",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-4 rounded-full bg-surface shadow-float-sm transition-transform duration-(--motion-fast) motion-reduce:transition-none",
          checked && "switch-thumb-on",
        )}
      />
    </button>
  );
}

export interface SettingsToggleRowProps extends Omit<ComponentProps<"div">, "children"> {
  label: string;
  detail?: string | undefined;
  checked: boolean;
  onCheckedChange?: ((checked: boolean) => void) | undefined;
  disabled?: boolean | undefined;
  /** Id the row's label points at. */
  id?: string | undefined;
}

/** A label, one line of detail, and the switch at the end. */
export function SettingsToggleRow({ label, detail, checked, onCheckedChange, disabled, id, className, ...props }: SettingsToggleRowProps) {
  return (
    <div data-slot="settings-toggle-row" className={cn("flex items-center gap-3", className)} {...props}>
      <span className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={id} className="truncate text-sm text-ink">
          {label}
        </label>
        {detail && <span className="truncate text-xs text-ink-3">{detail}</span>}
      </span>
      <SettingsSwitch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label} />
    </div>
  );
}
