import type { FileDiffPage, FileSource } from "./contract.js";

export function appendPatchPage(current: FileDiffPage, next: FileDiffPage): FileDiffPage {
  const { nextOffset: _previous, ...rest } = current;
  return {
    ...rest,
    patch: `${current.patch}${next.patch}`,
    ...(next.offset !== undefined ? { offset: next.offset } : {}),
    bytes: (current.bytes ?? 0) + (next.bytes ?? 0),
    truncated: next.truncated === true,
    ...(next.nextOffset !== undefined ? { nextOffset: next.nextOffset } : {}),
  };
}

export function loadedDiffFiles(
  oldFile: FileSource | null,
  newFile: FileSource | null,
  page: Pick<FileDiffPage, "path" | "oldPath">,
): { oldFile: { name: string; contents: string } | null; newFile: { name: string; contents: string } } {
  if (!oldFile && !newFile) {
    return { oldFile: null, newFile: { name: page.path, contents: "" } };
  }
  return {
    oldFile: oldFile ? { name: page.oldPath ?? page.path, contents: oldFile.contents } : null,
    newFile: newFile ? { name: page.path, contents: newFile.contents } : { name: page.path, contents: "" },
  };
}
