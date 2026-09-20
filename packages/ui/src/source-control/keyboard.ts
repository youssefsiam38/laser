export type OverlayKeyAction =
  | "close"
  | "find"
  | "next-file"
  | "prev-file"
  | "next-hunk"
  | "prev-hunk"
  | "toggle-viewed"
  | "next-tab"
  | "prev-tab"
  | "close-tab"
  | "toggle-unified"
  | "toggle-tree";

const EDITING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return EDITING.has(target.tagName);
}

/**
 * A focused overflow region — the diff, the file list, a stacked image — must
 * keep ArrowUp/ArrowDown for native scrolling. `j`/`k` still cycle files.
 */
export function isOverlayScrollTarget(event: KeyboardEvent): boolean {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  const nodes: EventTarget[] = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (event.target) nodes.push(event.target);
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const slot = node.dataset.slot;
    if (slot === "changes-diff-scroll" || slot === "changes-rail-scroll") return true;
    if (node.getAttribute("role") === "region" && node.tabIndex >= 0) return true;
  }
  return false;
}

/**
 * Overlay shortcuts. Find and close still fire while typing in the find field;
 * file/hunk motion does not.
 */
export function overlayKeyAction(
  event: KeyboardEvent,
  opts?: { gitActionOpen?: boolean },
): OverlayKeyAction | undefined {
  if (opts?.gitActionOpen) return undefined;
  const editing = isEditingTarget(event.target);
  const key = event.key;
  const lower = key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;

  if (key === "Escape") return "close";
  if (mod && !event.shiftKey && !event.altKey && lower === "f") return "find";
  if (mod && !event.altKey && key === "Tab") return event.shiftKey ? "prev-tab" : "next-tab";
  if (mod && !event.shiftKey && !event.altKey && lower === "w") return "close-tab";

  if (editing) return undefined;

  if (!mod && !event.altKey && (key === "ArrowDown" || lower === "j")) {
    if (key === "ArrowDown" && isOverlayScrollTarget(event)) return undefined;
    return "next-file";
  }
  if (!mod && !event.altKey && (key === "ArrowUp" || lower === "k")) {
    if (key === "ArrowUp" && isOverlayScrollTarget(event)) return undefined;
    return "prev-file";
  }
  if (!mod && !event.altKey && key === "]") return "next-hunk";
  if (!mod && !event.altKey && key === "[") return "prev-hunk";
  if (!mod && !event.altKey && lower === "v") return "toggle-viewed";
  if (!mod && !event.altKey && lower === "u") return "toggle-unified";
  if (!mod && !event.altKey && lower === "b") return "toggle-tree";
  return undefined;
}
