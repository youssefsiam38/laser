"use client";

import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { MarkdownDocument } from "@/components/assistant-ui/elements/markdown-document";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { MarkdownSourceEditorHandle, MarkdownSourceEditorProps } from "./MarkdownSourceEditor.js";

interface EditorActivationValue {
  active: boolean;
  readOnly: boolean;
  activeField: string | undefined;
  activate(field: string): void;
  ensure(field: string): void;
}

const EditorActivation = createContext<EditorActivationValue | undefined>(undefined);

/**
 * Keeps at most one CodeMirror view mounted for a kind. The selected view stays
 * mounted while its kind is hidden, so kind switching retains selection, undo,
 * and scroll without retaining one view for every optional row.
 */
export function MarkdownEditorActivationProvider({
  active,
  readOnly = false,
  children,
}: {
  active: boolean;
  readOnly?: boolean | undefined;
  children: ReactNode;
}) {
  const [activeField, setActiveField] = useState<string | undefined>(undefined);
  const activate = useCallback((field: string) => setActiveField(field), []);
  const ensure = useCallback((field: string) => setActiveField((current) => current ?? field), []);
  const value = useMemo<EditorActivationValue>(
    () => ({ active, readOnly, activeField, activate, ensure }),
    [active, activeField, activate, ensure, readOnly],
  );
  return <EditorActivation.Provider value={value}>{children}</EditorActivation.Provider>;
}

const LazyMarkdownSourceEditor = lazy(async () => {
  const module = await import("./MarkdownSourceEditor.js");
  return { default: module.MarkdownSourceEditor };
});

export interface MarkdownAuthoringFieldProps extends Omit<MarkdownSourceEditorProps, "label"> {
  label: string;
  /** Stable across row reordering and kind changes. */
  editorKey?: string | undefined;
  error?: string | undefined;
  className?: string | undefined;
}

export function MarkdownAuthoringField({ label, editorKey, error, className, readOnly = false, ...editorProps }: MarkdownAuthoringFieldProps) {
  const activation = useContext(EditorActivation);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const editor = useRef<MarkdownSourceEditorHandle>(null);
  const previousMode = useRef<"write" | "preview">("write");
  const id = useId();
  const fieldKey = editorKey ?? id;
  const writeId = `${id}-write`;
  const previewId = `${id}-preview`;
  const errorId = `${id}-error`;
  const writeTabId = `${id}-write-tab`;
  const previewTabId = `${id}-preview-tab`;
  const managed = activation !== undefined;
  const mounted = !managed || activation.activeField === fieldKey;
  const locked = readOnly || activation?.readOnly === true;
  const describedBy = [editorProps.describedBy, error ? errorId : undefined].filter(Boolean).join(" ") || undefined;

  useLayoutEffect(() => {
    if (activation?.active) activation.ensure(fieldKey);
  }, [activation?.active, activation?.ensure, fieldKey]);

  useEffect(() => {
    const returningToWrite = previousMode.current === "preview" && mode === "write";
    previousMode.current = mode;
    if (!returningToWrite || !mounted) return;
    const frame = requestAnimationFrame(() => {
      editor.current?.measure();
      editor.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, mounted]);

  const write = (): void => {
    if (locked) return;
    activation?.activate(fieldKey);
    setMode("write");
  };

  return (
    <section className={cn("flex min-w-0 flex-col gap-1.5", className)} aria-labelledby={`${id}-label`}>
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-label`} className="eyebrow">
          {label}
        </span>
        <div role="tablist" aria-label={`${label} view`} className="flex rounded-md bg-surface-2 p-0.5">
          <button
            id={writeTabId}
            type="button"
            role="tab"
            aria-selected={mode === "write"}
            aria-controls={writeId}
            tabIndex={mode === "write" ? 0 : -1}
            disabled={locked}
            className={cn("rounded-sm px-2 py-1 text-xs leading-xs text-ink-2", mode === "write" && "bg-surface text-ink shadow-xs")}
            onClick={write}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              setMode("preview");
              requestAnimationFrame(() => document.getElementById(previewTabId)?.focus());
            }}
          >
            Write
          </button>
          <button
            id={previewTabId}
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            aria-controls={previewId}
            tabIndex={mode === "preview" ? 0 : -1}
            disabled={locked}
            className={cn("rounded-sm px-2 py-1 text-xs leading-xs text-ink-2", mode === "preview" && "bg-surface text-ink shadow-xs")}
            onClick={() => setMode("preview")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              write();
              requestAnimationFrame(() => document.getElementById(writeTabId)?.focus());
            }}
          >
            Preview
          </button>
        </div>
      </div>

      <div
        id={writeId}
        role="tabpanel"
        aria-labelledby={writeTabId}
        aria-hidden={mode !== "write"}
        className={mode === "write" ? undefined : "hidden"}
      >
        {mounted ? (
          <Suspense fallback={<div className="min-h-24 rounded-md border border-line bg-surface p-3 text-sm text-ink-3">Loading editor…</div>}>
            <LazyMarkdownSourceEditor
              ref={editor}
              {...editorProps}
              label={label}
              readOnly={locked}
              {...(describedBy !== undefined ? { describedBy } : {})}
            />
          </Suspense>
        ) : (
          <div className="flex min-h-24 flex-col gap-2 rounded-md border border-line bg-surface p-3">
            {editorProps.value.trim() ? (
              <MarkdownDocument text={editorProps.value} measure="full" className="text-sm" />
            ) : (
              <p className="text-sm text-ink-3">Nothing written yet.</p>
            )}
            <Button type="button" size="xs" variant="outline" className="self-start" disabled={locked} onClick={write}>
              Edit source
            </Button>
          </div>
        )}
      </div>
      <div
        id={previewId}
        role="tabpanel"
        aria-labelledby={previewTabId}
        aria-hidden={mode !== "preview"}
        className={cn("min-h-24 rounded-md border border-line bg-surface p-3", mode !== "preview" && "hidden")}
      >
        {editorProps.value.trim() ? (
          <MarkdownDocument text={editorProps.value} measure="full" className="text-sm" />
        ) : (
          <p className="text-sm text-ink-3">Nothing to preview yet.</p>
        )}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs leading-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
