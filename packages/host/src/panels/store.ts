/**
 * PanelStore — the host's memory of every open panel, per session.
 *
 * Why the host keeps them: panel notifications are not part of the worker's
 * `seq`-numbered replay buffer, so a client that reloads would otherwise come
 * back to an empty dock while the runs it was watching are still going. The
 * store answers `pi/panel/list` and is the authority on which refs a client
 * may read (`pi/panel/read`): a ref is a grant only because a panel carried it.
 *
 * Pure bookkeeping, no I/O. Dedupes identical upserts (R9) so the broadcast
 * carries changes only.
 */
import { refsOf, type Panel, type Ref } from "@lasercode/protocol";

export interface RefGrant {
  /** Session the ref arrived on. */
  path: string;
  /** Panel that carried it. */
  panelId: string;
  /** Binary content (an image document): served as base64. */
  binary: boolean;
}

export interface UpsertResult {
  /** False when the same panel arrived again (at-least-once delivery). */
  changed: boolean;
  previous: Panel | undefined;
}

const BINARY_MEDIA = /^(image|audio|video|application\/(pdf|zip|octet-stream))/;

export class PanelStore {
  /** path → id → panel, in arrival order (creation order is the dock order). */
  private readonly byPath = new Map<string, Map<string, Panel>>();
  private readonly serialized = new Map<string, string>();
  private readonly grants = new Map<Ref, RefGrant>();

  upsert(path: string, panel: Panel): UpsertResult {
    const key = `${path}\n${panel.id}`;
    const next = JSON.stringify(panel);
    const previous = this.byPath.get(path)?.get(panel.id);
    if (previous && this.serialized.get(key) === next) return { changed: false, previous };
    let panels = this.byPath.get(path);
    if (!panels) {
      panels = new Map();
      this.byPath.set(path, panels);
    }
    if (previous) for (const ref of refsOf(previous)) this.grants.delete(ref);
    panels.set(panel.id, panel);
    this.serialized.set(key, next);
    const binary = panel.kind === "document" && BINARY_MEDIA.test(panel.mediaType);
    for (const ref of refsOf(panel)) this.grants.set(ref, { path, panelId: panel.id, binary });
    return { changed: true, previous };
  }

  /** Returns the panel that was closed, or undefined when nothing was open under that id. */
  close(path: string, id: string): Panel | undefined {
    const panels = this.byPath.get(path);
    const panel = panels?.get(id);
    if (!panels || !panel) return undefined;
    panels.delete(id);
    this.serialized.delete(`${path}\n${id}`);
    for (const ref of refsOf(panel)) this.grants.delete(ref);
    if (panels.size === 0) this.byPath.delete(path);
    return panel;
  }

  get(path: string, id: string): Panel | undefined {
    return this.byPath.get(path)?.get(id);
  }

  list(path: string): Panel[] {
    return [...(this.byPath.get(path)?.values() ?? [])];
  }

  /** Every open panel across every session (the fleet). */
  all(): Array<{ path: string; panel: Panel }> {
    const out: Array<{ path: string; panel: Panel }> = [];
    for (const [path, panels] of this.byPath) for (const panel of panels.values()) out.push({ path, panel });
    return out;
  }

  /** Forget a session's panels (its worker died, or the session closed). Returns what was dropped. */
  clear(path: string): Panel[] {
    const panels = this.list(path);
    for (const panel of panels) this.close(path, panel.id);
    return panels;
  }

  grantFor(ref: Ref): RefGrant | undefined {
    return this.grants.get(ref);
  }
}
