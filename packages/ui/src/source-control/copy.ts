/**
 * Selecting from a file header into code copies the header's +/− counts.
 * The overlay's copy path starts at the code, never the header.
 *
 * Chromium retargets `document.getSelection()` to the shadow host, so we read
 * each open root's `getSelection()` when it exists and write `text/plain`
 * ourselves.
 */
import { collectOpenShadowRoots } from "@/components/thread/find-ranges.js";

const HEADER = "[data-diffs-header]";
const LINE = "[data-line]";

type ShadowSelectionRoot = ShadowRoot & { getSelection?: () => Selection | null };

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export function rangeStartsInHeader(range: Range): boolean {
  const el = elementOf(range.startContainer);
  return Boolean(el?.closest(HEADER));
}

/** Move the range start to the first code line in the same tree. Returns whether it moved. */
export function clipRangeStartToCode(range: Range): boolean {
  if (!rangeStartsInHeader(range)) return false;
  const root = range.startContainer.getRootNode();
  const line = root instanceof Document || root instanceof ShadowRoot ? root.querySelector(LINE) : null;
  if (!line) return false;
  try {
    range.setStart(line, 0);
    return true;
  } catch {
    return false;
  }
}

export function clipSelectionToCode(selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return clipRangeStartToCode(selection.getRangeAt(0));
}

function selectionOf(root: Document | ShadowRoot): Selection | null {
  const getSel = (root as ShadowSelectionRoot).getSelection;
  if (typeof getSel === "function") return getSel.call(root) ?? null;
  if (root instanceof Document) return root.getSelection();
  return null;
}

function usableRange(selection: Selection | null): Range | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  return selection.getRangeAt(0).cloneRange();
}

function clipOrRetarget(range: Range, host: HTMLElement): Range {
  clipRangeStartToCode(range);
  if (range.startContainer === host || (range.startContainer instanceof Element && range.startContainer.contains(host))) {
    for (const root of collectOpenShadowRoots(host)) {
      const line = root.querySelector(LINE);
      if (!line) continue;
      try {
        range.setStart(line, 0);
        break;
      } catch {
        /* the line is not a valid start */
      }
    }
  }
  return range;
}

/** The range to copy: shadow-root selection first, then the document, clipped to code. */
export function overlayCopyRange(host: HTMLElement): Range | null {
  for (const root of collectOpenShadowRoots(host)) {
    const range = usableRange(selectionOf(root));
    if (range) return clipOrRetarget(range, host);
  }
  const range = usableRange(typeof document === "undefined" ? null : document.getSelection());
  if (!range) return null;
  return clipOrRetarget(range, host);
}

export function handleOverlayCopy(event: ClipboardEvent, host: HTMLElement): boolean {
  const range = overlayCopyRange(host);
  if (!range) return false;
  const text = range.toString();
  if (!text) return false;
  event.preventDefault();
  event.clipboardData?.setData("text/plain", text);
  return true;
}
