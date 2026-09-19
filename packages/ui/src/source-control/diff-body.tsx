/**
 * The Pierre renderer. Dynamic-imported from the overlay host so none of
 * `@pierre/diffs` sits in the startup bundle (D-317).
 *
 * Worker pool stays off: `disableWorkerPool` is always true, and this module
 * never references the worker URL.
 *
 * Three things this file owns beyond mounting the component:
 *
 *  - **Our type reaches the shadow root.** `DIFF_HOST_STYLE` on the wrapper
 *    and one appended stylesheet per root; see `diff-typography.ts` for why
 *    both, and for the `adoptedStyleSheets` trap.
 *  - **Context expansion is real.** The renderer is handed a *hydrated*,
 *    non-partial diff built from both sides of the file, never a patch plus a
 *    `loadDiffFiles` promise — that combination is the only thing that emits
 *    "More unchanged context may be available", and it is a sentence rather
 *    than a control. When the sides cannot be read we say so ourselves.
 *  - **The expanders are operable.** `useDiffShadowChrome` gives Pierre's
 *    `div[role="button"]` expanders a tab stop, a name that says how many
 *    lines a press reveals, and Enter/Space.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import {
  hydratePartialDiff,
  parsePatchFiles,
  registerCustomTheme,
  type FileDiffMetadata,
  type ThemeRegistration,
} from "@pierre/diffs";

import { LASER_SHIKI_THEME } from "@/components/assistant-ui/elements/shiki-theme.js";
import { useThemeBase } from "@/theme/use-theme.js";

import { classifyDiffPage } from "./classify.js";
import type { ChangesScope, FileDiffPage } from "./contract.js";
import { getChangesAdapter } from "./data.js";
import { EXPANSION_LINE_COUNT } from "./diff-expand.js";
import { expandableSides, expansionApplies, expansionNotice, type FetchedSides } from "./diff-files.js";
import { useDiffShadowChrome } from "./diff-shadow.js";
import { DIFF_HOST_STYLE } from "./diff-typography.js";
import { DiffErrorState, EmptyBodyState } from "./states.js";
import type { DiffStylePref } from "./prefs.js";

let themeRegistered = false;

function ensurePierreTheme(): void {
  if (themeRegistered) return;
  themeRegistered = true;
  const theme: ThemeRegistration = LASER_SHIKI_THEME;
  registerCustomTheme(LASER_SHIKI_THEME.name, async () => theme);
}

export function DiffBody({ page, scope, diffStyle }: { page: FileDiffPage; scope: ChangesScope; diffStyle: DiffStylePref }) {
  ensurePierreTheme();
  const base = useThemeBase();
  const adapter = getChangesAdapter();
  const host = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => {
    if (!page.patch.trim()) return [];
    try {
      return parsePatchFiles(page.patch).flatMap((patch) => patch.files);
    } catch {
      return "error" as const;
    }
  }, [page.patch]);

  const partial = parsed === "error" ? undefined : parsed[0];
  const pierreType = partial?.type;
  const { repo, path, oldPath } = page;

  // Both sides of the file, so the renderer holds the whole text and can open
  // the lines around a hunk without asking anyone. Fetched after the patch has
  // already painted: the hunks are the thing a person came to read.
  const [sides, setSides] = useState<FetchedSides | undefined>(undefined);
  useEffect(() => {
    setSides(undefined);
    if (!expansionApplies(pierreType)) return;
    const load = adapter.getFileSource;
    if (!load) {
      setSides({ old: null, next: null });
      return;
    }
    let cancelled = false;
    void Promise.all([
      load(scope, repo, oldPath ?? path, "old").catch(() => null),
      load(scope, repo, path, "new").catch(() => null),
    ]).then(([old, next]) => {
      if (!cancelled) setSides({ old, next });
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, pierreType, scope, repo, path, oldPath]);

  const expansion = expandableSides(pierreType, sides);
  const fileDiff = useMemo<FileDiffMetadata | undefined>(() => {
    if (!partial) return undefined;
    const old = sides?.old;
    const next = sides?.next;
    if (expansion !== "ready" || !old || !next) return partial;
    try {
      return hydratePartialDiff("clone", partial, {
        oldFile: { name: oldPath ?? path, contents: old.contents },
        newFile: { name: path, contents: next.contents },
      });
    } catch {
      // Sides that do not line up with the patch (the tree moved under us)
      // must never become a diff at plausible-looking wrong line numbers.
      return partial;
    }
  }, [partial, sides, expansion, path, oldPath]);

  useDiffShadowChrome(host, `${repo}\u0000${path}\u0000${diffStyle}\u0000${base}\u0000${expansion}`);

  const options = useMemo(
    () => ({
      theme: LASER_SHIKI_THEME.name,
      themeType: base,
      diffStyle,
      lineDiffType: "word" as const,
      expandUnchanged: false,
      disableFileHeader: true,
      hunkSeparators: "line-info" as const,
      disableLineNumbers: false,
      /* Bounded expansion: one press opens a screenful, never a file. */
      expansionLineCount: EXPANSION_LINE_COUNT,
    }),
    [base, diffStyle],
  );

  const empty = classifyDiffPage(page, partial ? { type: partial.type, hunks: partial.hunks.length } : { hunks: 0 });
  if (empty) return <EmptyBodyState body={empty} />;
  if (parsed === "error") {
    return <DiffErrorState message="This patch could not be read. Try another file, or another scope." />;
  }
  if (!fileDiff) {
    return <DiffErrorState message="This file has no textual diff to show." />;
  }

  const notice = expansionNotice(expansion);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        ref={host}
        data-slot="changes-diff"
        data-expansion={expansion}
        style={DIFF_HOST_STYLE}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <Virtualizer className="h-full">
          <FileDiff fileDiff={fileDiff} options={options} disableWorkerPool />
        </Virtualizer>
      </div>
      {notice ? (
        <p
          data-slot="changes-expansion-notice"
          className="shrink-0 hairline-t bg-surface-2 px-4 py-1.5 text-sm leading-sm text-ink-2"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
