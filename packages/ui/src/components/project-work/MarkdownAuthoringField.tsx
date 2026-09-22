"use client";

import { createContext, lazy, Suspense, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { MarkdownDocument } from "@/components/assistant-ui/elements/markdown-document";
import { cn } from "@/lib/utils";

import type { MarkdownSourceEditorHandle, MarkdownSourceEditorProps } from "./MarkdownSourceEditor.js";

const EditorActivation = createContext(true);

export function MarkdownEditorActivationProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <EditorActivation.Provider value={active}>{children}</EditorActivation.Provider>;
}

const LazyMarkdownSourceEditor = lazy(async () => {
  const module = await import("./MarkdownSourceEditor.js");
  return { default: module.MarkdownSourceEditor };
});

export interface MarkdownAuthoringFieldProps extends Omit<MarkdownSourceEditorProps, "label"> {
  label: string;
  error?: string | undefined;
  className?: string | undefined;
}

export function MarkdownAuthoringField({ label, error, className, ...editorProps }: MarkdownAuthoringFieldProps) {
  const active = useContext(EditorActivation);
  const [activated, setActivated] = useState(active);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const editor = useRef<MarkdownSourceEditorHandle>(null);
  const previousMode = useRef<"write" | "preview">("write");
  const id = useId();
  const writeId = `${id}-write`;
  const previewId = `${id}-preview`;
  const errorId = `${id}-error`;

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useEffect(() => {
    const returningToWrite = previousMode.current === "preview" && mode === "write";
    previousMode.current = mode;
    if (!returningToWrite) return;
    const frame = requestAnimationFrame(() => {
      editor.current?.measure();
      editor.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  return (
    <section className={cn("flex min-w-0 flex-col gap-1.5", className)} aria-labelledby={`${id}-label`}>
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-label`} className="eyebrow">
          {label}
        </span>
        <div role="tablist" aria-label={`${label} view`} className="flex rounded-md bg-surface-2 p-0.5">
          <button
            id={`${id}-write-tab`}
            type="button"
            role="tab"
            aria-selected={mode === "write"}
            aria-controls={writeId}
            tabIndex={mode === "write" ? 0 : -1}
            className={cn("rounded-sm px-2 py-1 text-xs leading-xs text-ink-2", mode === "write" && "bg-surface-1 text-ink shadow-xs")}
            onClick={() => setMode("write")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              setMode("preview");
              requestAnimationFrame(() => document.getElementById(`${id}-preview-tab`)?.focus());
            }}
          >
            Write
          </button>
          <button
            id={`${id}-preview-tab`}
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            aria-controls={previewId}
            tabIndex={mode === "preview" ? 0 : -1}
            className={cn("rounded-sm px-2 py-1 text-xs leading-xs text-ink-2", mode === "preview" && "bg-surface-1 text-ink shadow-xs")}
            onClick={() => setMode("preview")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              setMode("write");
              requestAnimationFrame(() => document.getElementById(`${id}-write-tab`)?.focus());
            }}
          >
            Preview
          </button>
        </div>
      </div>

      <div id={writeId} role="tabpanel" aria-hidden={mode !== "write"} className={mode === "write" ? undefined : "hidden"}>
        {activated ? (
          <Suspense fallback={<div className="min-h-24 rounded-md border border-line bg-surface-1 p-3 text-sm text-ink-3">Loading editor…</div>}>
            <LazyMarkdownSourceEditor ref={editor} {...editorProps} label={label} describedBy={error ? errorId : editorProps.describedBy} />
          </Suspense>
        ) : null}
      </div>
      <div
        id={previewId}
        role="tabpanel"
        aria-hidden={mode !== "preview"}
        className={cn("min-h-24 rounded-md border border-line bg-surface-1 p-3", mode !== "preview" && "hidden")}
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
