import type { AppState, SessionView } from "../store.js";

/** Only shell/fleet title and lifecycle consumers may use this comparison.
 * Transcript content, queues, tools, and requests must read the real store.
 * Keep both first-user conventions: the sidebar accepts an empty first line,
 * while an unlisted fleet root uses the first nonempty one.
 */
function titleInputs(view: SessionView): readonly unknown[] {
  const first = view.blocks.find((block) => block.kind === "user");
  const nonempty = view.blocks.find((block) => block.kind === "user" && block.text?.trim());
  return [first, nonempty];
}

export function samePresentationViews(
  a: Readonly<Record<string, SessionView | undefined>>,
  b: Readonly<Record<string, SessionView | undefined>>,
): boolean {
  if (a === b) return true;
  const paths = Object.keys(a);
  if (paths.length !== Object.keys(b).length) return false;
  return paths.every((path) => {
    const left = a[path], right = b[path];
    if (left === right) return true;
    if (!left || !right || left.state !== right.state || left.running !== right.running
      || left.title !== right.title || left.dialogs !== right.dialogs || left.openedAt !== right.openedAt) return false;
    const l = titleInputs(left), r = titleInputs(right);
    return l[0] === r[0] && l[1] === r[1];
  });
}

/** Render-only snapshot. Imperative actions always use store.getSnapshot. */
export function createShellSnapshot(read: () => AppState): () => AppState {
  let previous: AppState | undefined;
  return () => {
    const next = read();
    if (previous === next) return next;
    if (previous && Object.keys(next).every((key) => key === "open"
      ? samePresentationViews(previous!.open, next.open)
      : previous![key as keyof AppState] === next[key as keyof AppState])) return previous;
    return previous = next;
  };
}
