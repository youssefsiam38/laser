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

/**
 * Two readings of one session that a title, a status or a lifecycle control
 * cannot tell apart. Everything a streamed token moves — the blocks, the
 * sequence, the loaded entries — is deliberately absent, which is the point:
 * a surface that compares views with this one does not re-render for a token.
 *
 * Only a surface that draws none of the transcript may use it. A surface that
 * reads `blocks`, `entries`, `lastSeq` or the queue must read those fields
 * itself, or it will draw one batch behind.
 */
export function samePresentationView(a: SessionView | undefined, b: SessionView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.path !== b.path || a.state !== b.state || a.running !== b.running
    || a.title !== b.title || a.dialogs !== b.dialogs || a.openedAt !== b.openedAt
    || a.history?.userOffset !== b.history?.userOffset || a.history?.hasHistory !== b.history?.hasHistory) return false;
  const l = titleInputs(a), r = titleInputs(b);
  return l[0] === r[0] && l[1] === r[1];
}

/** The session a surface is showing; pair it with {@link samePresentationView}. */
export function currentView(state: AppState): SessionView | undefined {
  return state.current ? state.open[state.current] : undefined;
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
    // `samePresentationView` also compares the path; inside one map the key is
    // the path, so an entry that differs only there cannot occur.
    return samePresentationView(left, right);
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
