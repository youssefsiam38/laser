/**
 * The last thing between a render error and a black window.
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * and Electron then shows exactly what is left: nothing. A person reading a
 * long conversation hit that, and quitting the app was the only way out. This
 * boundary keeps them in the app instead: it says what happened in plain
 * words and offers a reload. A reload restarts only this window — the host,
 * every session and everything running keep going.
 *
 * A class because React catches render errors nowhere else. It renders no
 * theme of its own: it sits inside the same root the app painted, so the
 * tokens are already there.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";

interface Props { children: ReactNode }
interface State { failed: boolean }

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only channel that survives the tree. The desktop's
    // main process copies renderer errors into its log, one bounded line each,
    // so the message and the component stack go out as one string.
    // The JavaScript stack says where it was thrown; the component stack says
    // which surface was drawing. Both, bounded: a minified stack's first
    // frames are what a source map can still answer for.
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const thrown = error instanceof Error && error.stack ? `\n${error.stack.split("\n").slice(1, 9).join("\n")}` : "";
    console.error(`The window could not draw itself. ${reason}${thrown}${info.componentStack ?? ""}`);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-dvh items-center justify-center bg-surface p-6 text-ink">
        <div className="w-full max-w-md">
          <ErrorState
            title="Something went wrong drawing this window."
            detail="Your conversations and anything running are unaffected. Reload the window to continue where you were."
            onRetry={() => window.location.reload()}
            retryLabel="Reload"
          />
        </div>
      </main>
    );
  }
}
