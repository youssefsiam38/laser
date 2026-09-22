"use client";

import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";

export interface MarkdownSourceEditorHandle {
  focus(): void;
  measure(): void;
}

export interface MarkdownSourceEditorProps {
  value: string;
  onChange(value: string): void;
  label: string;
  describedBy?: string | undefined;
  placeholder?: string | undefined;
  maxLength?: number | undefined;
  onCreateShortcut?(): void;
}

const theme = EditorView.theme({
  "&": {
    color: "var(--ink)",
    backgroundColor: "var(--surface-1)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  ".cm-content": { padding: "calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 3)" },
  ".cm-scroller": { overflow: "auto", minHeight: "calc(var(--space-unit) * 24)", maxHeight: "calc(var(--space-unit) * 48)" },
  ".cm-focused": { outline: "calc(var(--space-unit) * 0.5) solid var(--live)", outlineOffset: "calc(var(--space-unit) * -0.25)" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in oklab, var(--live) 24%, transparent)" },
  ".cm-placeholder": { color: "var(--ink-3)" },
  ".cm-gutters": { display: "none" },
});

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, color: "var(--live)", fontWeight: "var(--weight-semibold)" },
    { tag: [tags.strong, tags.emphasis], color: "var(--ink)" },
    { tag: [tags.link, tags.url], color: "var(--live)" },
    { tag: [tags.monospace, tags.string], color: "var(--ok)" },
    { tag: [tags.meta, tags.punctuation, tags.quote], color: "var(--ink-3)" },
  ]),
);

export const MarkdownSourceEditor = forwardRef<MarkdownSourceEditorHandle, MarkdownSourceEditorProps>(function MarkdownSourceEditor(
  { value, onChange, label, describedBy, placeholder, maxLength, onCreateShortcut },
  forwardedRef,
) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping, theme, highlight], []);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => editor.current?.view?.focus(),
      measure: () => editor.current?.view?.requestMeasure(),
    }),
    [],
  );

  return (
    <div
      className="overflow-hidden rounded-md border border-line bg-surface-1"
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        onCreateShortcut?.();
      }}
    >
      <CodeMirror
        ref={editor}
        value={value}
        onChange={(next) => {
          if (maxLength !== undefined && next.length > maxLength) return;
          onChange(next);
        }}
        extensions={extensions}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, indentOnInput: false }}
        theme="none"
        {...(placeholder !== undefined ? { placeholder } : {})}
        aria-label={label}
        {...(describedBy !== undefined ? { "aria-describedby": describedBy } : {})}
      />
    </div>
  );
});
