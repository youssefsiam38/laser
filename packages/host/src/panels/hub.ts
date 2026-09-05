/**
 * PanelHub — where panels enter the host and leave for clients.
 *
 * Inputs: `pi/extension/message` notifications from a worker carrying
 * `laser/panel/upsert` / `laser/panel/close` (the companion `panels`
 * module), plus session lifecycle. Outputs: `pi/panel/upsert` /
 * `pi/panel/close` broadcasts, attention (a blocking decision lights the
 * session row, R5), and the answers to `pi/panel/list` and `pi/panel/read`.
 *
 * Wiring (HostServer.observe / Router) is three calls: `observeExtensionMessage`
 * where extension messages are seen, `list` and `read` in the router, and
 * `sessionClosed` when a worker drops a session.
 */
import type { HostNotifications, Panel, PanelReadResult, PiExtensionMessage } from "@lasercode/protocol";
import { RefReader, type RefReaderDeps } from "./refs.js";
import { PanelStore } from "./store.js";

export interface PanelHubDeps {
  notify<M extends "pi/panel/upsert" | "pi/panel/close">(method: M, params: HostNotifications[M]): void;
  /** The attention tracker's dialog hooks; a blocking decision is a dialog for the inbox. */
  attention?:
    | {
        dialogRaised(path: string, cwd: string, id: string): void;
        dialogResolved(path: string, id: string): void;
      }
    | undefined;
  logContent?: RefReaderDeps["logContent"];
}

/** Attention ids for decision panels share the dialog namespace with a prefix nothing else uses. */
const attentionId = (panelId: string): string => `panel:${panelId}`;

export class PanelHub {
  readonly store = new PanelStore();
  private readonly reader: RefReader;

  constructor(private readonly deps: PanelHubDeps) {
    this.reader = new RefReader({ grantFor: (ref) => this.store.grantFor(ref), logContent: deps.logContent });
  }

  /**
   * Fold one extension message in. Returns true when it was a panel message
   * (so a caller that also logs extension messages can skip these).
   */
  observeExtensionMessage(cwd: string, path: string, message: PiExtensionMessage): boolean {
    switch (message.type) {
      case "lasercode/panel/upsert":
        this.upsert(cwd, path, message.panel);
        return true;
      case "lasercode/panel/close":
        this.close(path, message.id, message.reason);
        return true;
      default:
        return false;
    }
  }

  upsert(cwd: string, path: string, panel: Panel): void {
    const { changed, previous } = this.store.upsert(path, panel);
    if (!changed) return;
    // R5 is unconditional: a `decision` anywhere lights its session row, its
    // project ring and the inbox, whatever it blocks. `attentionOf` in the
    // protocol derives the same answer with no reference to `blocking`, and
    // the two halves have to agree or a phone that never opened the session
    // cannot find the question — which is the trip the inbox exists to save.
    if (panel.kind === "decision" && previous?.kind !== "decision") {
      this.deps.attention?.dialogRaised(path, cwd, attentionId(panel.id));
    }
    // Nothing pins a panel's kind across upserts, and "the question is
    // answered, here is the work" is a plausible thing to emit under one id.
    // Resolve on the transition, or the session waits for you forever.
    if (previous?.kind === "decision" && panel.kind !== "decision") {
      this.deps.attention?.dialogResolved(path, attentionId(panel.id));
    }
    this.deps.notify("pi/panel/upsert", { path, panel });
  }

  close(path: string, id: string, reason?: string): void {
    this.store.close(path, id);
    // Unconditional: `dialogResolved` is a no-op for an id the set does not
    // hold, and reading the kind back would miss a panel that changed kind
    // between the raise and the close.
    this.deps.attention?.dialogResolved(path, attentionId(id));
    // A close for a panel the host never held is still forwarded: the client
    // may hold it from a previous host process, and "nothing vanishes
    // silently" (R7) is the client's rule to keep, not ours to pre-empt.
    this.deps.notify("pi/panel/close", { path, id, ...(reason !== undefined ? { reason } : {}) });
  }

  /** The session left its worker: every panel of it ends, and says why. */
  sessionClosed(path: string, reason = "the session closed"): void {
    for (const panel of this.store.list(path)) this.close(path, panel.id, reason);
  }

  /** A worker died: its sessions' panels are gone with it. */
  workerLost(paths: readonly string[], reason = "the worker stopped"): void {
    for (const path of paths) this.sessionClosed(path, reason);
  }

  list(path: string): { panels: Panel[] } {
    return { panels: this.store.list(path) };
  }

  read(params: { path: string; ref: string; from: number; to: number }): Promise<PanelReadResult> {
    return this.reader.read(params.path, params.ref, params.from, params.to);
  }
}
