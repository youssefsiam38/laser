/**
 * The Pierre renderer. Dynamic-imported from the overlay host so none of
 * `@pierre/diffs` sits in the startup bundle (D-317).
 *
 * Worker pool stays off: `disableWorkerPool` is always true, and this module
 * never references the worker URL.
 */
import { useMemo } from "react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { parsePatchFiles, registerCustomTheme } from "@pierre/diffs";

import { LASER_SHIKI_THEME } from "@/components/assistant-ui/elements/shiki-theme.js";
import { useThemeBase } from "@/theme/use-theme.js";

import { classifyDiffPage } from "./classify.js";
import type { ChangesScope, FileDiffPage } from "./contract.js";
import { getChangesAdapter } from "./data.js";
import { DiffErrorState, EmptyBodyState } from "./states.js";
import type { DiffStylePref } from "./prefs.js";

let themeRegistered = false;

function ensurePierreTheme(): void {
  if (themeRegistered) return;
  themeRegistered = true;
  registerCustomTheme(LASER_SHIKI_THEME.name, async () => LASER_SHIKI_THEME as never);
}

export function DiffBody({ page, scope, diffStyle }: { page: FileDiffPage; scope: ChangesScope; diffStyle: DiffStylePref }) {
  ensurePierreTheme();
  const base = useThemeBase();
  const parsed = useMemo(() => {
    if (!page.patch.trim()) return [];
    try {
      return parsePatchFiles(page.patch).flatMap((patch) => patch.files);
    } catch {
      return "error" as const;
    }
  }, [page.patch]);

  const fileDiff = parsed === "error" ? undefined : parsed[0];
  const empty = classifyDiffPage(page, fileDiff ? { type: fileDiff.type, hunks: fileDiff.hunks.length } : { hunks: 0 });
  if (empty) return <EmptyBodyState body={empty} />;
  if (parsed === "error") {
    return <DiffErrorState message="This patch could not be read. Try another file, or another scope." />;
  }
  if (!fileDiff) {
    return <DiffErrorState message="This file has no textual diff to show." />;
  }

  const adapter = getChangesAdapter();
  const load = adapter.getFileSource;
  const options = {
    theme: LASER_SHIKI_THEME.name,
    themeType: base,
    diffStyle,
    lineDiffType: "word" as const,
    expandUnchanged: false,
    disableFileHeader: true,
    hunkSeparators: "line-info" as const,
    disableLineNumbers: false,
    ...(load
      ? {
          loadDiffFiles: async () => {
            const oldFile = await load(scope, page.repo, page.oldPath ?? page.path, "old");
            const newFile = await load(scope, page.repo, page.path, "new");
            if (!oldFile && !newFile) return { oldFile: null, newFile: { name: page.path, contents: "" } };
            return {
              oldFile: oldFile ? { name: page.oldPath ?? page.path, contents: oldFile.contents } : null,
              newFile: newFile ? { name: page.path, contents: newFile.contents } : { name: page.path, contents: "" },
            };
          },
        }
      : {}),
  };

  return (
    <div
      data-slot="changes-diff"
      className="min-h-0 min-w-0 flex-1 overflow-hidden [--diffs-bg-override:var(--surface)] [--diffs-fg-override:var(--ink)]"
    >
      <Virtualizer className="h-full">
        <FileDiff fileDiff={fileDiff} options={options} disableWorkerPool />
      </Virtualizer>
    </div>
  );
}
