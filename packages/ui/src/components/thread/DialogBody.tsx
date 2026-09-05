import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCountdown } from "./timing.js";

/** The portable dialog surface (AGENTS.md inv. 6), minus transport ids. */
export interface DialogSpec {
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly title: string;
  readonly message?: string | undefined;
  readonly options?: readonly string[] | undefined;
  readonly placeholder?: string | undefined;
  readonly prefill?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface DialogBodyProps {
  dialog: DialogSpec;
  /** select / input / editor answer. */
  onValue: (value: string) => void;
  /** confirm answer. */
  onConfirm: (confirmed: boolean) => void;
  onCancel: () => void;
  /** `card` = free-standing above the composer; `footer` = inside a tool row. */
  variant?: "card" | "footer";
  /** Eyebrow shown above the title, e.g. "Extension · select". */
  eyebrow?: string | undefined;
  autoFocus?: boolean;
  className?: string | undefined;
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);
}

/**
 * Non-modal, keyboard-first dialog body shared by free-standing cards and
 * tool-row footers. Esc cancels; Enter submits inputs; Cmd/Ctrl+Enter submits
 * the editor; select options are focusable buttons with arrow-key movement.
 */
export function DialogBody({
  dialog,
  onValue,
  onConfirm,
  onCancel,
  variant = "card",
  eyebrow,
  autoFocus = true,
  className,
}: DialogBodyProps) {
  const id = useId();
  const [value, setValue] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
  const secondsLeft = useCountdown(dialog.timeoutMs);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const root = rootRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>("[data-autofocus]");
    target?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (dialog.method === "select" && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? []);
      const current = buttons.findIndex((b) => b === document.activeElement);
      if (buttons.length === 0) return;
      e.preventDefault();
      const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
      const next = current < 0 ? 0 : (current + (forward ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }
  };

  const submitValue = () => onValue(value);
  const mod = isMac() ? "⌘" : "Ctrl";

  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
          <p id={`${id}-title`} className={cn("font-medium text-ink", variant === "card" ? "text-base" : "text-sm")}>
            {dialog.title}
          </p>
          {dialog.message ? <p className="mt-1 text-sm whitespace-pre-wrap text-ink-2">{dialog.message}</p> : null}
        </div>
        {secondsLeft !== undefined ? (
          <span
            className={cn("typed shrink-0 pt-0.5 tnum", secondsLeft <= 5 ? "text-attention" : "text-ink-3")}
            aria-live="polite"
          >
            {secondsLeft}s
          </span>
        ) : null}
      </div>

      {dialog.method === "select" ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Options">
          {(dialog.options ?? []).map((option, i) => (
            <Button
              key={`${i}-${option}`}
              variant="outline"
              size="sm"
              data-option
              {...(i === 0 ? { "data-autofocus": true } : {})}
              onClick={() => onValue(option)}
            >
              {option}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : null}

      {dialog.method === "confirm" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" data-autofocus onClick={() => onConfirm(true)}>
            Yes
          </Button>
          <Button variant="outline" size="sm" onClick={() => onConfirm(false)}>
            No
          </Button>
        </div>
      ) : null}

      {dialog.method === "input" ? (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            submitValue();
          }}
        >
          <input
            data-autofocus
            aria-label={dialog.title}
            value={value}
            placeholder={dialog.placeholder ?? ""}
            onChange={(e) => setValue(e.currentTarget.value)}
            className={cn(
              "h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-base text-ink outline-none",
              "placeholder:text-ink-3 hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
              "focus-visible:border-live focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live/25",
            )}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Submit
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {dialog.method === "editor" ? (
        <div className="flex flex-col gap-2">
          <Textarea
            data-autofocus
            aria-label={dialog.title}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitValue();
              }
            }}
            className="max-h-72 min-h-28 font-mono text-xs leading-[18px]"
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submitValue}>
              Submit
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <span className="ms-auto hidden items-center gap-1 text-2xs text-ink-3 sm:inline-flex">
              <Kbd>{mod}</Kbd>
              <Kbd>⏎</Kbd>
              <span className="ms-0.5">submit</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
