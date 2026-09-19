/**
 * The overlay is a leaf surface: nothing it draws may take the conversation
 * down with it.
 *
 * `@pierre/diffs` asserts its own invariants *during render* — a hydrated
 * diff whose two sides disagree with the patch throws while the virtualizer
 * estimates row heights. React unmounts the whole tree above an uncaught
 * render throw, so one bad file took the window into `AppErrorBoundary`
 * ("Something went wrong drawing this window") with the transcript, the
 * toolbar and the file list gone with it.
 *
 * This boundary sits around the diff body alone. A throw below it becomes a
 * state inside the body: the toolbar, the tab strip and the rail keep
 * drawing, and the person can pick another file — which is the one thing they
 * want to do next.
 *
 * It resets when `resetKey` changes, so the error belongs to the file that
 * could not be drawn and not to the surface. Without that, the first bad file
 * would make every later file look broken too.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { DiffDrawFailedState } from "./states.js";

interface Props {
  /** Identity of what is being drawn; a change clears the error. */
  resetKey: string;
  /** Called with the reason, so a retry can be offered by the owner. */
  onError?: (error: unknown) => void;
  children: ReactNode;
}

interface State {
  failed: boolean;
  resetKey: string;
}

export class DiffBodyBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is where a renderer error still reaches the desktop log.
    // Bounded, one line: what threw, and which surface was drawing.
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const thrown = error instanceof Error && error.stack ? `\n${error.stack.split("\n").slice(1, 6).join("\n")}` : "";
    console.error(`The diff could not be drawn. ${reason}${thrown}${info.componentStack ?? ""}`);
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <DiffDrawFailedState />;
  }
}
