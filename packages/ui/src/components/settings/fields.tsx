"use client";
/**
 * Form controls generated from a `SettingDescriptor`.
 *
 * Every control edits a *draft* string/value locally and commits on blur (or
 * immediately for toggles and selects), because a settings write takes Pi's
 * file lock and reloads the session's settings manager — far too heavy to run
 * per keystroke. A control that cannot represent the stored value (someone
 * hand-edited the file) says so and offers the raw JSON instead of silently
 * showing a wrong widget.
 */
import { useEffect, useId, useState } from "react";
import { Plus, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SettingDescriptor, SettingOption } from "@piorbit/protocol";

export interface FieldProps {
  field: SettingDescriptor;
  /** Value at the edited scope, or undefined when the scope does not set it. */
  value: unknown;
  disabled?: boolean | undefined;
  /** `undefined` unsets the key so Pi's default applies again. */
  onCommit: (value: unknown) => void;
  /**
   * The id the row's `<label>` points at. Every control here takes one, so a
   * screen reader announces the setting's name instead of "combo box, not set"
   * fifty-one times.
   */
  id?: string | undefined;
}

/** Shared shape for the controls below: they all name themselves. */
interface ControlProps {
  value: unknown;
  disabled?: boolean | undefined;
  onCommit: (value: unknown) => void;
  id?: string | undefined;
  /** The setting's human name, for the aria-labels of secondary controls. */
  label: string;
}

const inputClass = [
  "h-8 w-full min-w-0 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink",
  "placeholder:text-ink-3 transition-[border-color] duration-75 outline-none",
  "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
  "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
  "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60",
].join(" ");

/** JSON round-trip so `false` and `0` survive a `<select>`'s string values. */
const encode = (value: SettingOption["value"]): string => JSON.stringify(value);

export function SettingField({ field, value, disabled, onCommit, id }: FieldProps) {
  const type = field.type;
  const common = { value, disabled, onCommit, id, label: field.label };
  switch (type.control) {
    case "boolean":
      return <BooleanField field={field} value={value} disabled={disabled} onCommit={onCommit} id={id} />;
    case "enum":
      return <EnumField options={type.options} {...common} />;
    case "number":
      return <NumberField spec={type} {...common} />;
    case "text":
      return <TextField spec={type} {...common} />;
    case "string-list":
      return <StringListField spec={type} {...common} />;
    case "enum-map":
      return <EnumMapField spec={type} {...common} />;
    case "json":
      return <JsonField hint={type.hint} {...common} />;
  }
}

function BooleanField({ field, value, disabled, onCommit, id }: FieldProps) {
  const fallbackId = useId();
  const controlId = id ?? fallbackId;
  const set = value !== undefined;
  const on = set ? value === true : field.default === true;
  return (
    <label
      htmlFor={controlId}
      className={cn("inline-flex items-center gap-2 text-sm", disabled ? "opacity-60" : "cursor-pointer")}
    >
      <input
        id={controlId}
        type="checkbox"
        role="switch"
        aria-label={field.label}
        checked={on}
        disabled={disabled}
        onChange={(event) => onCommit(event.currentTarget.checked)}
        className="size-4 accent-live"
      />
      <span className={set ? "text-ink" : "text-ink-3"}>{on ? "on" : "off"}</span>
    </label>
  );
}

function EnumField({ options, value, disabled, onCommit, id, label }: ControlProps & { options: SettingOption[] }) {
  const current = value === undefined ? "" : encode(value as SettingOption["value"]);
  const known = current === "" || options.some((option) => encode(option.value) === current);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <select
        id={id}
        aria-label={label}
        value={known ? current : ""}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.value === "" ? undefined : JSON.parse(event.target.value))}
        className={cn(inputClass, "pe-7")}
      >
        <option value="">— not set —</option>
        {options.map((option) => (
          <option key={encode(option.value)} value={encode(option.value)}>
            {option.label}
            {option.hint ? ` — ${option.hint}` : ""}
          </option>
        ))}
      </select>
      {!known && <UnrepresentableNote value={value} />}
    </div>
  );
}

function NumberField({
  spec,
  value,
  disabled,
  onCommit,
  id,
  label,
}: ControlProps & { spec: Extract<SettingDescriptor["type"], { control: "number" }> }) {
  const stored = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);

  const commit = () => {
    const text = draft.trim();
    // A blur that changed nothing must not write. Every commit takes Pi's file
    // lock, rewrites the file and reloads the settings manager — tabbing
    // through the form would be one of those per field, and on a project with
    // no `.pi` yet it would create a trust-gated file Pi then ignores.
    if (text === stored.trim()) {
      setError(undefined);
      return;
    }
    if (text === "") {
      setError(undefined);
      onCommit(undefined);
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return setError("Enter a number.");
    if (spec.integer && !Number.isInteger(parsed)) return setError("Whole numbers only.");
    if (spec.min !== undefined && parsed < spec.min) return setError(`Minimum is ${spec.min}.`);
    if (spec.max !== undefined && parsed > spec.max) return setError(`Maximum is ${spec.max}.`);
    setError(undefined);
    onCommit(parsed);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          aria-label={label}
          type="text"
          inputMode="numeric"
          value={draft}
          disabled={disabled}
          aria-invalid={error !== undefined}
          placeholder="not set"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          className={cn(inputClass, "w-40 font-mono tnum", error && "border-danger")}
        />
        {spec.unit && <span className="font-mono text-2xs text-ink-3">{spec.unit}</span>}
      </div>
      {error && <p className="text-2xs text-danger">{error}</p>}
    </div>
  );
}

function TextField({
  spec,
  value,
  disabled,
  onCommit,
  id,
  label,
}: ControlProps & { spec: Extract<SettingDescriptor["type"], { control: "text" }> }) {
  const stored = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(typeof value === "string" ? value : ""), [value]);
  // Same rule as NumberField: a blur that changed nothing writes nothing.
  const commit = () => {
    if (draft === stored) return;
    onCommit(draft === "" ? undefined : draft);
  };

  if (spec.multiline) {
    return (
      <Textarea
        id={id}
        aria-label={label}
        value={draft}
        disabled={disabled}
        placeholder={spec.placeholder ?? "not set"}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className="max-h-40 min-h-16 text-sm"
      />
    );
  }
  return (
    <input
      id={id}
      aria-label={label}
      type="text"
      value={draft}
      disabled={disabled}
      placeholder={spec.placeholder ?? "not set"}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      className={cn(inputClass, "max-w-96 font-mono text-[13px]")}
    />
  );
}

function StringListField({
  spec,
  value,
  disabled,
  onCommit,
  id,
  label,
}: ControlProps & { spec: Extract<SettingDescriptor["type"], { control: "string-list" }> }) {
  const items = Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
  const [draft, setDraft] = useState("");
  // Editing an existing entry is local until blur: every commit takes Pi's
  // settings lock and reloads the session's settings manager, which is far too
  // heavy to run per keystroke. Adding and removing commit immediately.
  const [editing, setEditing] = useState<string[] | undefined>();

  if (value !== undefined && items === undefined) return <UnrepresentableNote value={value} />;
  const list = editing ?? items ?? [];
  const replace = (next: string[]) => {
    setEditing(undefined);
    onCommit(next.length === 0 && items === undefined ? undefined : next);
  };

  return (
    <div className="flex min-w-0 max-w-120 flex-col gap-1.5">
      {list.length > 0 && (
        <ul className="flex flex-col gap-1">
          {list.map((item, index) => (
            <li key={`${item}-${index}`} className="flex items-center gap-1">
              <input
                type="text"
                aria-label={`${label}: entry ${index + 1}`}
                value={item}
                disabled={disabled}
                onChange={(event) => {
                  const next = [...list];
                  next[index] = event.target.value;
                  setEditing(next);
                }}
                onBlur={() => {
                  if (editing) replace(editing.filter((entry, i) => entry !== "" || i !== index));
                }}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                className={cn(inputClass, "font-mono text-[13px]")}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`Remove ${item}`}
                onClick={() => replace(list.filter((_, i) => i !== index))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <input
          id={id}
          aria-label={`${label}: add an entry`}
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={spec.placeholder ?? "add an entry"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || draft.trim() === "") return;
            event.preventDefault();
            replace([...list, draft.trim()]);
            setDraft("");
          }}
          className={cn(inputClass, "font-mono text-[13px]")}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || draft.trim() === ""}
          aria-label="Add entry"
          onClick={() => {
            replace([...list, draft.trim()]);
            setDraft("");
          }}
        >
          <Plus />
        </Button>
      </div>
      {items !== undefined && list.length === 0 && (
        <p className="text-2xs text-ink-3">
          An empty list is a real value here, and means something different from not setting the key.{" "}
          <button type="button" className="text-live underline-offset-2 hover:underline" onClick={() => onCommit(undefined)}>
            Unset it
          </button>
          .
        </p>
      )}
      {spec.hint && <p className="text-2xs text-ink-3">{spec.hint}</p>}
    </div>
  );
}

function EnumMapField({
  spec,
  value,
  disabled,
  onCommit,
  id,
  label,
}: ControlProps & { spec: Extract<SettingDescriptor["type"], { control: "enum-map" }> }) {
  const map = isRecord(value) ? (value as Record<string, unknown>) : undefined;
  const [key, setKey] = useState("");
  if (value !== undefined && map === undefined) return <UnrepresentableNote value={value} />;

  const entries = Object.entries(map ?? {});
  const replace = (next: Record<string, unknown>) =>
    onCommit(Object.keys(next).length === 0 ? undefined : next);

  return (
    <div className="flex min-w-0 max-w-140 flex-col gap-1.5">
      {entries.map(([entryKey, entryValue]) => (
        <div key={entryKey} className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink" title={entryKey}>
            {entryKey}
          </span>
          <select
            aria-label={`${label}: value for ${entryKey}`}
            value={String(entryValue)}
            disabled={disabled}
            onChange={(event) => replace({ ...map, [entryKey]: event.target.value })}
            className={cn(inputClass, "w-32")}
          >
            {spec.options.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={`Remove ${entryKey}`}
            onClick={() => {
              const next = { ...map };
              delete next[entryKey];
              replace(next);
            }}
          >
            <X />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <input
          id={id}
          aria-label={`${label}: add a key`}
          type="text"
          value={key}
          disabled={disabled}
          placeholder={spec.keyPlaceholder ?? "key"}
          onChange={(event) => setKey(event.target.value)}
          className={cn(inputClass, "flex-1 font-mono text-[13px]")}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || key.trim() === ""}
          aria-label="Add entry"
          onClick={() => {
            replace({ ...map, [key.trim()]: spec.options[0]!.value });
            setKey("");
          }}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

function JsonField({ hint, value, disabled, onCommit, id, label }: ControlProps & { hint?: string | undefined }) {
  const serialized = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setDraft(serialized), [serialized]);

  const dirty = draft !== serialized;
  const commit = () => {
    const text = draft.trim();
    if (text === "") {
      setError(undefined);
      onCommit(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      setError(undefined);
      onCommit(parsed);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "That is not valid JSON.");
    }
  };

  return (
    <div className="flex min-w-0 max-w-160 flex-col gap-1.5">
      <Textarea
        id={id}
        aria-label={`${label} (JSON)`}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        placeholder="not set"
        onChange={(event) => setDraft(event.target.value)}
        className={cn("max-h-72 min-h-24 font-mono text-[12px] leading-5", error && "border-danger")}
      />
      <div className="flex items-center gap-2">
        <Button size="xs" variant="secondary" disabled={disabled || !dirty} onClick={commit}>
          Apply JSON
        </Button>
        {dirty && (
          <Button size="xs" variant="ghost" onClick={() => setDraft(serialized)}>
            <RotateCcw /> Discard
          </Button>
        )}
        {error && <span className="text-2xs text-danger">{error}</span>}
      </div>
      {hint && <p className="text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}

function UnrepresentableNote({ value }: { value: unknown }) {
  return (
    <p className="max-w-120 rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-2xs leading-4 text-ink-2">
      This file holds a value this control cannot show: <span className="text-attention">{JSON.stringify(value)}</span>.
      Edit it in the JSON view, or in the settings file directly.
    </p>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
