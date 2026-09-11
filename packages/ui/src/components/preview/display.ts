import type { ProjectFileContent } from "@lasercode/protocol";
import { diffViewForTool, type DiffView } from "@lasercode/protocol/tool-diff";
import { previewKindFor } from "./media.js";

/** Shared text/Markdown/source ceiling; applied before parsing or highlighting. */
export const MAX_PREVIEW_CHARS = 120_000;

export function boundedPreviewText(text: string): string {
  return text.slice(0, MAX_PREVIEW_CHARS);
}

export function boundedPreview(file: ProjectFileContent): { file: ProjectFileContent; diff: DiffView | undefined } {
  if (file.encoding !== "utf8") return { file, diff: undefined };
  const content = boundedPreviewText(file.content);
  // This public projection uses the protocol's canonical bounded()/MAX_DIFF_LINES.
  const diff = previewKindFor(file.mediaType, file.path) === "diff"
    ? diffViewForTool("edit", { path: file.path }, { patch: content }) : undefined;
  return { file: { ...file, content, truncated: file.truncated || content.length < file.content.length || diff?.truncated === true }, diff };
}
