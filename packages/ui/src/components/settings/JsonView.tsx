"use client";
/**
 * The JSON escape hatch.
 *
 * The file as Pi loaded it, editable. Saving diffs the document against the
 * catalogue and sends only the paths that changed, so keys piorbit does not
 * know about survive untouched. An edit piorbit cannot express as a change to
 * a known setting is refused by name rather than dropped — the one failure mode
 * a raw editor must not have.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import type { SettingChange, SettingsCatalog, SettingsScope, SettingsSnapshot } from "@piorbit/protocol";

import { changesFromJson } from "./model.js";

export interface JsonViewProps {
  catalog: SettingsCatalog;
  snapshot: SettingsSnapshot;
  scope: SettingsScope;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

export function JsonView({ catalog, snapshot, scope, onApply }: JsonViewProps) {
  const file = scope === "global" ? snapshot.global : snapshot.project;
  const serialized = useMemo(() => `${JSON.stringify(file.values, null, 2)}\n`, [file.values]);
  const [draft, setDraft] = useState(serialized);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const { copied, copy } = useCopy();

  useEffect(() => {
    setDraft(serialized);
    setProblem(undefined);
  }, [serialized]);

  const dirty = draft !== serialized;
  const readOnly = scope === "project" && !snapshot.projectTrust.writable;

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (error) {
      setProblem(`That is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setProblem("A settings file must be a JSON object.");
      return;
    }
    const { changes, unrepresentable } = changesFromJson(
      catalog,
      file.values,
      parsed as Record<string, unknown>,
      scope,
    );
    if (unrepresentable.length > 0) {
      setProblem(
        `piorbit can only write settings Pi ${catalog.piVersion} defines, and cannot apply your edits to ` +
          `${unrepresentable.slice(0, 6).join(", ")}${unrepresentable.length > 6 ? ", …" : ""}. ` +
          `Nothing was saved. Undo those edits, or edit ${file.path} directly.`,
      );
      return;
    }
    if (changes.length === 0) {
      setProblem("Nothing to save — this document matches the file.");
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      await onApply(scope, changes);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-3" title={file.path}>
          {file.path}
          {file.exists ? "" : " · does not exist yet"}
        </span>
        <Button variant="ghost" size="xs" className="gap-1" onClick={() => void copy(draft)}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
        {dirty && (
          <Button variant="ghost" size="xs" className="gap-1" onClick={() => setDraft(serialized)}>
            <RotateCcw /> Discard
          </Button>
        )}
        <Button size="xs" disabled={!dirty || readOnly || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {file.error && (
        <p className="rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-xs leading-5 text-danger">
          Pi could not parse this file: {file.error}. piorbit will not overwrite a settings file it cannot read — fix it
          here or in your editor, then reload.
        </p>
      )}
      {problem && (
        <p className="rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-xs leading-5 text-danger">
          {problem}
        </p>
      )}
      {readOnly && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs leading-5 text-ink-2">
          {snapshot.projectTrust.reason}
        </p>
      )}

      <textarea
        value={draft}
        readOnly={readOnly}
        spellCheck={false}
        aria-label={`${scope} settings JSON`}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(
          "min-h-0 flex-1 w-full resize-none rounded-lg border border-line bg-surface p-3",
          "font-mono text-[12px] leading-5 text-ink outline-none",
          "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
          readOnly && "bg-surface-2 opacity-80",
        )}
      />
      <p className="text-2xs leading-4 text-ink-3">
        Saving sends only the settings that changed. Keys piorbit does not recognise are never rewritten, so a file
        edited by a newer Pi stays intact.
      </p>
    </div>
  );
}
