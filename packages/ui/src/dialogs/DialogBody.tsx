import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useLogicalArrowKeys } from "@/hooks/use-direction";

import { ApprovalCard } from "@/components/assistant-ui/elements/approval-card";
import { ElicitationForm, type FieldValues } from "@/components/assistant-ui/elements/elicitation-form";
import { PermissionGrant } from "@/components/assistant-ui/elements/permission-grant";
import { useCountdown } from "@/components/thread/timing";
import { Kbd } from "@/components/ui/kbd";
import { modKey } from "@/format";
import { cn } from "@/lib/utils";
import { blockingWords, isModeChangingOption, type DialogField, type DialogForm } from "./model.js";

export interface DialogBodyProps {
  form: DialogForm;
  /** Answer with values keyed by field id, or cancel with `undefined`. */
  onAnswer(values: Record<string, string | boolean> | undefined): Promise<unknown>;
  /** Free-standing card vs. inside another surface. */
  variant?: "card" | "sheet";
  /**
   * Coarse pointer: one-hand controls. Everything an answer needs grows to a
   * 48px row at 14px, stacked full width and ordered so the primary action is
   * nearest the thumb. Same component, same states — a bigger budget, not a
   * second design (docs/ux-fleet.md).
   */
  touch?: boolean;
  /** Start in the rejection state — a notification's "Deny…" opens the reason field. */
  initialDeclining?: boolean;
  autoFocus?: boolean;
  className?: string | undefined;
}

/**
 * Something blocking on you: a field list, its blocking scope, and a
 * rejection field that opens on "No" so declining is never a dead end.
 *
 * The one question *controller* in the app. The footer inside a tool row and
 * the card above the composer are this component in two places, which is why
 * a question never looks like two different things.
 * What it draws is the catalog's (docs/ux-elements.md): a one-question
 * approval is `ApprovalCard`; a choice that widens scope is `PermissionGrant`;
 * anything with fields to fill — including the rejection reason — is
 * `ElicitationForm`. Keyboard-first: Enter submits a one-line field,
 * ⌘/Ctrl+Enter a long one, Esc cancels, arrows move between choices.
 */
export function DialogBody({ form, onAnswer, variant = "card", touch = false, initialDeclining = false, autoFocus = true, className }: DialogBodyProps) {
  const logicalKey = useLogicalArrowKeys();
  const id = useId();
  const [values, setValues] = useState<FieldValues>(() => defaults(form.fields));
  const [declining, setDeclining] = useState(initialDeclining);
  const [busy, setBusy] = useState(false);
  const secondsLeft = useCountdown(form.timeoutMs);
  const rootRef = useRef<HTMLDivElement>(null);

  const rejectionField = form.rejection ? form.fields.find((f) => f.id === form.rejection?.field) : undefined;
  const visible = form.fields.filter((f) => f !== rejectionField);
  const single = visible.length === 1 ? visible[0] : undefined;
  const onlyConfirm = single?.type === "confirm";

  useEffect(() => {
    if (!autoFocus) return;
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (!declining) return;
    rootRef.current?.querySelector<HTMLElement>("[data-rejection]")?.focus({ preventScroll: true });
  }, [declining]);

  const submit = async (override?: FieldValues): Promise<void> => {
    const next = { ...values, ...override };
    for (const field of visible) {
      if (field.required && field.type !== "confirm" && !String(next[field.id] ?? "").trim()) {
        rootRef.current?.querySelector<HTMLElement>(`[data-field="${field.id}"]`)?.focus();
        return;
      }
    }
    setBusy(true);
    try {
      await onAnswer(next);
    } finally {
      setBusy(false);
    }
  };

  const decline = (): void => {
    if (form.rejection && rejectionField && !declining) {
      setDeclining(true);
      return;
    }
    void submit(onlyConfirm ? { [single!.id]: false } : {});
  };

  const cancel = (): void => void onAnswer(undefined);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (declining) setDeclining(false);
      else cancel();
      return;
    }
    if (single?.type === "choice" && ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) {
      const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? []);
      if (buttons.length === 0) return;
      e.preventDefault();
      const current = buttons.findIndex((b) => b === document.activeElement);
      const forward = logicalKey(e.key) === "ArrowRight" || e.key === "ArrowDown";
      buttons[current < 0 ? 0 : (current + (forward ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };

  const header = {
    titleId: `${id}-title`,
    eyebrow: `${form.source} · ${blockingWords(form.blocking)}`,
    title: form.title,
    message: form.message,
    secondsLeft,
    large: variant === "sheet",
  };
  const setValue = (fieldId: string, value: string | boolean) => setValues((s) => ({ ...s, [fieldId]: value }));
  const hint = (long: boolean) =>
    touch ? null : (
      <span className="ms-auto hidden items-center gap-1 text-xs text-ink-3 sm:inline-flex" aria-hidden="true">
        {long ? (
          <>
            <Kbd>{modKey()}</Kbd>
            <Kbd>⏎</Kbd>
          </>
        ) : (
          <Kbd>⏎</Kbd>
        )}
        <span className="ms-0.5">submit</span>
      </span>
    );

  let body: React.ReactNode;
  if (declining && rejectionField) {
    // "No" opened its field: the reason, and "<No> and send".
    body = (
      <ElicitationForm
        {...header}
        touch={touch}
        busy={busy}
        fields={[rejectionField]}
        values={values}
        onChange={setValue}
        onSubmit={() => void submit(onlyConfirm ? { [single!.id]: false } : {})}
        submitLabel={`${form.rejection?.label ?? "No"} and send`}
        destructive
        secondary={{ label: "Back", onClick: () => setDeclining(false) }}
        onCancel={cancel}
        focusMarker="data-rejection"
        hint={hint(true)}
      />
    );
  } else if (single?.type === "choice") {
    const options = single.options ?? [];
    const widens = options.some(isModeChangingOption);
    body = widens ? (
      <PermissionGrant
        {...header}
        touch={touch}
        busy={busy}
        options={options.map((label) => ({ label, modeChanging: isModeChangingOption(label) }))}
        onGrant={(option) => void submit({ [single.id]: option })}
        declineLabel={form.rejection && rejectionField ? form.rejection.label : undefined}
        onDecline={form.rejection && rejectionField ? decline : undefined}
        onCancel={cancel}
      />
    ) : (
      <ApprovalCard
        {...header}
        touch={touch}
        busy={busy}
        choices={options}
        onChoose={(option) => void submit({ [single.id]: option })}
        declineLabel={form.rejection?.label ?? "Cancel"}
        onDecline={decline}
        onCancel={form.rejection && rejectionField ? undefined : cancel}
        modeChanging={isModeChangingOption}
      />
    );
  } else if (onlyConfirm) {
    body = (
      <ApprovalCard
        {...header}
        touch={touch}
        busy={busy}
        onAllow={() => void submit({ [single!.id]: true })}
        declineLabel={form.rejection?.label ?? "No"}
        onDecline={decline}
      />
    );
  } else {
    body = (
      <ElicitationForm
        {...header}
        touch={touch}
        busy={busy}
        fields={visible}
        values={values}
        onChange={setValue}
        onSubmit={() => void submit()}
        submitLabel="Submit"
        secondary={form.rejection && rejectionField ? { label: form.rejection.label, onClick: decline } : undefined}
        onCancel={cancel}
        hint={hint(visible.some((f) => f.type === "longtext"))}
      />
    );
  }

  return (
    <div ref={rootRef} role="group" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown} className={cn("flex flex-col", className)}>
      {body}
    </div>
  );
}

function defaults(fields: readonly DialogField[]): FieldValues {
  const out: FieldValues = {};
  for (const field of fields) if (field.default !== undefined) out[field.id] = field.default;
  return out;
}
